// Unit tests for the team launcher's pure pieces: per-member session ids, territorial mount flags,
// member env, persona assembly, and the persona-file write. (The container launch itself needs
// Docker and is validated via the rebuild recipe in docs.)
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import { join } from 'node:path'
import { parseRoster, validateRoster } from '../src/teams/roster.js'
import { addAuthorizedRepo, removeAuthorizedRepo, loadAuthorizedRepos, _authPathForTest } from '../src/teams/repo-auth.js'
import { volumeName } from '../src/docker.js'
import { readMrcrc, sanitizeRepoConfig } from '../src/config.js'
import {
  memberSessionId, memberWorkspaceVolumes, memberEnv, personaForMember, writePersonaFile, orgDef, memberLaunch, cleanWorkerOutput,
  rosterFromDef, addMemberToRoster, removeMemberFromRoster, writeTeamFile,
  memberConfigVolName, memberArgv, memberDockerFilter, reposAction,
} from '../src/commands/team.js'

test('removeMemberFromRoster drops the member and any team left empty', () => {
  const roster = { org: 'shop', teams: [
    { name: 'client', members: [{ name: 'Roland', role: 'architect', backend: 'claude', lead: true }, { name: 'Vespa', role: 'engineer', backend: 'claude' }] },
    { name: 'solo', members: [{ name: 'Solo', role: 'engineer', backend: 'claude' }] },
  ] }
  const r1 = removeMemberFromRoster(roster, 'vespa/claude')
  assert.equal(r1.teams.find((t) => t.name === 'client').members.length, 1, 'Vespa removed')
  const r2 = removeMemberFromRoster(r1, 'solo/claude')
  assert.ok(!r2.teams.find((t) => t.name === 'solo'), 'empty team dropped')
})

test('writeTeamFile PRESERVES the personas block across a daemon roster-sync (#51)', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'mrc-51-'))
  const file = join(dir, 'team.json')
  const tj = { project: 'x', personas: { 'ux-expert': { label: 'UX Expert', mandate: 'design', mount: 'ro' } },
    teams: [{ name: 't', members: [{ name: 'Zoe', role: 'ux-expert', backend: 'claude', lead: true }] }] }
  fs.writeFileSync(file, JSON.stringify(tj, null, 2))
  // simulate the daemon's defineOrg sync: build a def (which does NOT carry personas) → writeTeamFile(rosterFromDef(def))
  const norm = parseRoster(tj, { repo: dir })
  const def = { org: norm.org, repo: dir, members: norm.members, rooms: norm.rooms }
  assert.equal(writeTeamFile(dir, rosterFromDef(def)), true)
  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(after.personas, tj.personas, 'personas survive the roster-sync (were silently erased before #51)')
  assert.deepEqual(Object.keys(after).sort(), ['personas', 'project', 'teams'])
  // a roster that explicitly carries personas (the team-save path) writes them; and the result still parses
  assert.equal(writeTeamFile(dir, { org: 'x', personas: { adv: { label: 'Ad', mandate: 'ads' } }, teams: [{ name: 't', members: [{ role: 'engineer', backend: 'claude' }] }] }), true)
  const after2 = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(after2.personas), ['adv'], 'explicit personas replace the on-disk ones')
  assert.doesNotThrow(() => parseRoster(after2, { repo: dir }))
})

test('rosterFromDef carries team.json personas so a rebuild keeps custom-role charters; a live add gets the charter (#43)', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'mrc-43-'))
  const tj = { project: 'x', personas: { 'ux-expert': { label: 'UX Expert', mandate: 'You own UX design.', mount: 'ro' } },
    teams: [{ name: 't', members: [{ name: 'Zoe', role: 'architect', backend: 'claude', lead: true }, { name: 'Slarti', role: 'ux-expert', backend: 'claude' }] }] }
  fs.writeFileSync(join(dir, 'team.json'), JSON.stringify(tj, null, 2))
  const n0 = parseRoster(tj, { repo: dir })
  const def = { org: n0.org, repo: dir, members: n0.members, rooms: n0.rooms }
  const roster = rosterFromDef(def)
  assert.deepEqual(roster.personas, tj.personas, 'rosterFromDef carries personas from team.json (def has none)')
  // existing custom-role member survives a rebuild with label+mandate intact
  const slarti = parseRoster(roster, { repo: dir }).members.find((m) => m.handle === 'slarti/claude')
  assert.equal(slarti.roleLabel, 'UX Expert')
  assert.equal(slarti.personaDef.mandate, 'You own UX design.')
  // a custom-role member added LIVE (the addmember rebuild path) resolves live WITH its charter
  const updated = addMemberToRoster(roster, 't', { role: 'ux-expert', backend: 'claude' })
  const added = parseRoster(updated, { repo: dir }).members.find((m) => m.role === 'ux-expert' && m.handle !== 'slarti/claude')
  assert.equal(added.tier, 'live')
  assert.equal(added.roleLabel, 'UX Expert')
  assert.equal(added.personaDef.mandate, 'You own UX design.')
})

test('rosterFromDef round-trips a multi-team project (no team or member is lost)', () => {
  const n0 = parseRoster({ org: 'shop', teams: [
    { name: 'client', territory: 'client', members: [{ role: 'architect', backend: 'claude', lead: true }, { role: 'engineer', backend: 'claude' }] },
    { name: 'api', territory: 'api', members: [{ role: 'architect', backend: 'claude', lead: true }, { role: 'engineer', backend: 'codex' }] },
  ] }, { repo: '/tmp/shop' })
  const before = n0.members.map((m) => m.handle).sort()
  const n1 = parseRoster(rosterFromDef({ org: n0.org, repo: n0.repo, members: n0.members }), { repo: '/tmp/shop' })
  assert.deepEqual(n1.members.map((m) => m.handle).sort(), before, 'all members across both teams preserved')
  assert.equal(new Set(n1.members.map((m) => m.team)).size, 2, 'both teams present')
})

test('add-member preserves existing members\' names and appends the new one', () => {
  const n0 = parseRoster({ org: 'shop', teams: [{ name: 'client', territory: '.', members: [
    { role: 'architect', backend: 'claude', lead: true }, { role: 'engineer', backend: 'claude' },
  ] }] }, { repo: '/tmp/shop' })
  const before = n0.members.map((m) => m.handle)
  const pinned = rosterFromDef({ org: n0.org, repo: n0.repo, members: n0.members })
  const updated = addMemberToRoster(pinned, 'client', { role: 'engineer', backend: 'claude', territory: 'server' })
  const n1 = parseRoster(updated, { repo: '/tmp/shop' })
  for (const h of before) assert.ok(n1.members.some((m) => m.handle === h), `${h} preserved`)
  assert.equal(n1.members.length, before.length + 1)
  const added = n1.members.find((m) => !before.includes(m.handle))
  assert.equal(added.role, 'engineer'); assert.equal(added.team, 'client'); assert.equal(added.territory, 'server')
})

function seededRng(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const ROSTER = {
  org: 'shop',
  teams: [{ name: 'client', territory: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'Roland', lead: true },
    { role: 'engineer', backend: 'claude', name: 'Ludivine', territory: 'client/src' },
    { role: 'critic', backend: 'claude', name: 'Pierre' },
  ] }],
}
const norm = () => parseRoster(ROSTER, { repo: '/tmp/shop', rng: seededRng(1) })
const find = (n, role) => n.members.find((m) => m.role === role)

test('memberSessionId is deterministic and a valid v5-shaped UUID', () => {
  const a = memberSessionId('shop', 'roland/claude')
  const b = memberSessionId('shop', 'roland/claude')
  assert.equal(a, b)
  assert.match(a, UUID_RE)
  assert.notEqual(a, memberSessionId('shop', 'pierre/claude'))
  assert.notEqual(a, memberSessionId('other', 'roland/claude'))
})

test('memberSessionId: team.js and the shared session-id module agree byte-for-byte', async () => {
  // The daemon builds its register-disambiguation index from the shared module while the launcher
  // pins --session-id from team.js's copy; if they ever drift, a member could never bind. Guard it.
  const { memberSessionId: shared } = await import('../src/teams/session-id.js')
  for (const [org, h] of [['shop', 'roland/claude'], ['alpha', 'côme/claude'], ['x y', 'a/codex']]) {
    assert.equal(shared(org, h), memberSessionId(org, h), `${org}/${h}`)
  }
})

// #49: memberWorkspaceVolumes now realpath-canonicalizes the mount SOURCE (the guard requires a real path),
// so these use a REAL temp repo. The SOURCE (left of colon) is the resolved host path; the TARGET (right of
// colon) stays the declared spelling.
test('memberWorkspaceVolumes: whole-repo engineer gets rw /workspace (source realpath-canonical)', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-mwv-')))
  try {
    assert.deepEqual(memberWorkspaceVolumes({ mount: 'rw', territory: '.' }, repo), ['-v', `${repo}:/workspace`])
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})

test('memberWorkspaceVolumes: read-only member gets ro /workspace + rw .mrc', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-mwv-')))
  try {
    const v = memberWorkspaceVolumes({ mount: 'ro', territory: 'client' }, repo)   // .mrc need not exist (write-mode canonicalizer)
    assert.deepEqual(v, ['-v', `${repo}:/workspace:ro`, '-v', `${join(repo, '.mrc')}:/workspace/.mrc`])
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})

test('memberWorkspaceVolumes: sub-tree engineer gets ro repo + rw .mrc + rw its (existing) territory', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-mwv-')))
  try {
    fs.mkdirSync(join(repo, 'client', 'src'), { recursive: true })   // the territory MUST exist (guard throws otherwise — the fail-closed change)
    const v = memberWorkspaceVolumes({ mount: 'rw', territory: 'client/src' }, repo)
    assert.deepEqual(v, [
      '-v', `${repo}:/workspace:ro`,
      '-v', `${join(repo, '.mrc')}:/workspace/.mrc`,
      '-v', `${join(repo, 'client', 'src')}:/workspace/client/src`,
    ])
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})

test('memberWorkspaceVolumes: a symlink territory escaping the repo is REJECTED (the live escape, closed)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-mwv-')))
  try {
    const repo = join(root, 'repo'); fs.mkdirSync(repo)
    const outside = join(root, 'outside'); fs.mkdirSync(outside)
    fs.symlinkSync(outside, join(repo, 'evil'))   // territory 'evil' -> outside the repo
    assert.throws(() => memberWorkspaceVolumes({ mount: 'rw', territory: 'evil' }, repo), /escapes the repo/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('memberEnv carries handle/team/role + persona path', () => {
  const n = norm(); const w = find(n, 'engineer')
  const e = memberEnv(w, '/workspace/.mrc/teams/ludivine-claude.persona')
  assert.ok(e.includes(`MRC_MEMBER_HANDLE=${w.handle}`))
  assert.ok(e.includes(`MRC_TEAM=${w.team}`))
  assert.ok(e.includes(`MRC_ROLE=${w.role}`))
  assert.ok(e.some((x) => x.startsWith('MRC_PERSONA_FILE=')))
})

test('personaForMember builds the role prompt with identity, teammates, territory', () => {
  const n = norm(); const w = find(n, 'engineer')
  const p = personaForMember(n, w)
  assert.match(p, /You are @Ludivine/)
  assert.match(p, /Engineer on the "client" team/)
  assert.match(p, /@roland/)                 // teammate listed
  assert.match(p, /@pierre/)                 // teammate listed
  assert.match(p, /client\/src/)             // its writable territory
  assert.match(p, /Do NOT run `git commit`/) // human-commits rule
})

test('lead persona includes the leads-room instruction', () => {
  const n = norm(); const a = find(n, 'architect')
  assert.match(personaForMember(n, a), /LEADS room/)
})

test('writePersonaFile writes under .mrc/teams and returns the in-container path', () => {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-team-'))
  const n = norm(); const w = find(n, 'engineer')
  const p = writePersonaFile(repo, w, 'PERSONA BODY')
  assert.equal(p, `/workspace/.mrc/teams/${w.handle.replace('/', '-')}.persona`)
  const onDisk = join(repo, '.mrc', 'teams', `${w.handle.replace('/', '-')}.persona`)
  assert.equal(fs.readFileSync(onDisk, 'utf8'), 'PERSONA BODY')
})

test('orgDef is the serializable shape the daemon expects', () => {
  const n = norm()
  const def = orgDef(n)
  assert.equal(def.org, 'shop')
  assert.ok(Array.isArray(def.members) && Array.isArray(def.rooms))
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(def)))
})

test('cleanWorkerOutput extracts the worker reply from the container chatter', () => {
  const raw = 'Waiting for network...\nNetwork ready after 2s\n[firewall up]\n===MRC-WORKER-OUTPUT-START===\nDone: added client/api/parse.js\n===MRC-WORKER-OUTPUT-END===\n'
  assert.equal(cleanWorkerOutput(raw), 'Done: added client/api/parse.js')
  assert.match(cleanWorkerOutput('no markers, just tail text'), /tail text/)   // graceful fallback
})

test('Inc 2: member.repo — default = the org repo; unauthorized cross-repo REFUSED at parse; authorized resolves', () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-mr-')))
  const orgRepo = join(root, 'orgrepo'); fs.mkdirSync(orgRepo)
  const other = join(root, 'otherrepo'); fs.mkdirSync(other)
  const org = `test-inc2-${process.pid}`
  const mk = (members) => parseRoster({ project: org, teams: [{ name: 't', members }] }, { repo: orgRepo })
  try {
    // default: no member.repo → the org repo, raw (no config-volume shift for existing members)
    assert.equal(mk([{ name: 'a', role: 'engineer', backend: 'claude' }]).members[0].repo, orgRepo)
    // explicit cross-repo, UNAUTHORIZED (empty set) → refused at PARSE, legibly, with the member handle
    assert.throws(() => mk([{ name: 'b', role: 'engineer', backend: 'claude', repo: other }]), /@b.*not authorized/)
    // after a HUMAN authorizes it for THIS org → resolves to the canonical cross-repo
    addAuthorizedRepo(org, other)
    assert.equal(mk([{ name: 'c', role: 'engineer', backend: 'claude', repo: other }]).members[0].repo, other)
  } finally { fs.rmSync(root, { recursive: true, force: true }); try { fs.unlinkSync(_authPathForTest(org)) } catch {} }
})

test('validateRoster missing-territory: MOUNTED members (engineer, tester) ERROR; media-maker (host-side write) EXEMPT', () => {
  // #49 (Pierre — mechanism-derived, not a role list): a member whose LAUNCH MOUNTS its territory
  // (canonicalMountSource, throws on missing) errors legibly at validate; a media-maker writes host-side
  // (canonicalWriteTarget, tolerate-and-create) so a missing territory is fine. The TESTER is live+rw → MOUNTS
  // → NOT exempt, despite being in the overlap-exempt set (a different concept). Three members, two mechanisms.
  const repo = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-terr-')))
  try {
    const n = parseRoster({ teams: [{ name: 't', members: [
      { name: 'eng', role: 'engineer', backend: 'claude', mount: 'rw', territory: 'code-missing' },
      { name: 'des', role: 'designer', backend: 'claude', mount: 'rw', territory: 'assets-missing' },
      { name: 'tst', role: 'tester',   backend: 'claude', mount: 'rw', territory: 'tests-missing' },
    ] }] }, { repo })
    const errText = validateRoster(n).errors.join(' | ')
    assert.match(errText, /@eng.*not found/, 'code engineer with a missing MOUNTED territory → error')
    assert.match(errText, /@tst.*not found/, 'tester (live+rw, MOUNTS) → error — NOT existence-exempt despite the overlap set')
    assert.ok(!/@des/.test(errText), 'media designer writes host-side (canonicalWriteTarget creates the dir) → NOT an error')
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})

test('memberLaunch assembles env + territorial volumes + a stable session id', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-team-')))
  try {
    fs.mkdirSync(join(repo, 'client', 'src'), { recursive: true })   // the engineer's territory must exist (guard)
    const n = norm()
    // #49: a member's launch roots at member.repo (persona-write + mount). In production the inner is launched
    // with repoPath === member.repo; the shared norm() is parsed against '/tmp/shop', so pin the member's repo to
    // the real temp dir this test operates on (mirrors the production invariant repoPath === member.repo).
    const w = { ...find(n, 'engineer'), repo }
    const launch = memberLaunch(n, w, repo)
    assert.match(launch.sessionId, UUID_RE)
    assert.ok(launch.workspaceVolumes.some((x) => x.endsWith('client/src:/workspace/client/src')))
    assert.ok(launch.envFlags.some((x) => x.startsWith('MRC_PERSONA_FILE=')))
    assert.match(launch.persona, /You are @Ludivine/)
  } finally { fs.rmSync(repo, { recursive: true, force: true }) }
})

// ─── #49 multi-repo "Mouth B": a member living in a DIFFERENT authorized repo ───────────────────────────

// Pierre regressor #1: the config-vol cross-org credential-share. member.repo is NOT org-unique once repos are
// shared, so two orgs that both authorize /srv/shared and each draw the same handle would collide on
// `${repo}#${handle}` and SHARE one ~/.claude. The org-scoped key must keep them DISTINCT — AND own-repo members
// must stay byte-identical (no gratuitous re-login). Both halves, or it's half a test.
test('#49 memberConfigVolName: two orgs sharing a repo + the SAME handle get DISTINCT config vols (no cross-org ~/.claude share)', () => {
  const shared = '/srv/shared', handle = 'apolline/claude'
  const mA = { repo: shared, handle, crossRepo: true }
  const mB = { repo: shared, handle, crossRepo: true }
  const volA = memberConfigVolName(mA, '/home/alice/teamA', 'orgA')
  const volB = memberConfigVolName(mB, '/home/bob/teamB', 'orgB')
  assert.notEqual(volA, volB, 'two orgs, one shared repo, colliding handle → the vols MUST differ (org folded into the key)')
  // and neither is the naive colliding key that WOULD have been shared
  const collidingKey = volumeName(`${shared}#${handle}`, 1)
  assert.notEqual(volA, collidingKey)
  assert.notEqual(volB, collidingKey)
})
test('#49 memberConfigVolName: an OWN-repo member is BYTE-IDENTICAL to today (crossRepo false → `${repo}#${handle}`), zero re-login', () => {
  const repo = '/home/alice/proj', handle = 'ludivine/claude'
  // crossRepo explicitly false (blob-stamped) AND the fallback (repo === repoPath) must both give today's key.
  const today = volumeName(`${repo}#${handle}`, 1)
  assert.equal(memberConfigVolName({ repo, handle, crossRepo: false }, repo, 'proj'), today)
  assert.equal(memberConfigVolName({ repo, handle }, repo, 'proj'), today, 'no crossRepo field + repo===repoPath → own-repo → byte-identical')
  // two DIFFERENT orgs, each own-repo (distinct team repos), same handle → still distinct (the repo is a faithful proxy here)
  assert.notEqual(memberConfigVolName({ repo: '/a', handle }, '/a', 'orgA'), memberConfigVolName({ repo: '/b', handle }, '/b', 'orgB'))
})
// Pierre (worker-path finding): a cross-repo WORKER reaches memberConfigVolName with repoPath===member.repo (the
// daemon launches `_worker-exec --repo member.repo`, so execWorker collapses repoPath to member.repo). The
// repo-compare fallback would then say "own-repo" → the NAIVE colliding key. The AUTHORITATIVE crossRepo (stamped
// at the mint, carried through the worker blob) must OVERRIDE the fallback → org-scoped. This is the test that
// would have caught the worker-tier hole: it drives the exact shape (crossRepo:true, repoPath===member.repo).
test('#49 memberConfigVolName: a cross-repo WORKER (crossRepo:true, repoPath===member.repo) is STILL org-scoped, not the naive colliding key', () => {
  const shared = '/srv/shared', handle = 'apolline/claude'
  const wA = memberConfigVolName({ repo: shared, handle, crossRepo: true }, shared, 'orgA')   // repoPath === member.repo (the collapse)
  const wB = memberConfigVolName({ repo: shared, handle, crossRepo: true }, shared, 'orgB')
  assert.notEqual(wA, wB, 'two orgs, cross-repo WORKERS, shared repo, colliding handle → DISTINCT config vols (org overrides the fallback)')
  assert.notEqual(wA, volumeName(`${shared}#${handle}`, 1), 'NOT the naive `${repo}#${handle}` the repo-compare fallback would have picked')
})
// And the mint really stamps crossRepo, so the worker blob (a plain spread of the member) inherits it — the fix's
// root cause. Prove it end-to-end: parse a roster with an authorized cross-repo member → member.crossRepo === true;
// an own-repo member → false. (This is what makes room-daemon's `{...member}` worker blob org-scoped for free.)
test('#49 the MINT stamps member.crossRepo (so BOTH blob constructors + execWorker inherit it)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-mint-')))
  const foreign = join(root, 'foreign'); fs.mkdirSync(foreign)
  const org = `test-mint-${process.pid}`
  try {
    const mk = (members) => parseRoster({ project: org, teams: [{ name: 't', members }] }, { repo: root })
    assert.equal(mk([{ name: 'own', role: 'engineer', backend: 'claude' }]).members[0].crossRepo, false, 'own-repo member → crossRepo false')
    addAuthorizedRepo(org, foreign)
    assert.equal(mk([{ name: 'x', role: 'engineer', backend: 'claude', repo: foreign }]).members[0].crossRepo, true, 'authorized cross-repo member → crossRepo true')
  } finally { fs.rmSync(root, { recursive: true, force: true }); try { fs.unlinkSync(_authPathForTest(org)) } catch {} }
})

// Pierre regressor #2: the teardown must find a cross-repo member by mrc.project=<RAW org>, never mrc.repo (a
// cross-repo container is labelled mrc.repo=member.repo, which no team-repo filter would match).
test('#49 memberDockerFilter: disambiguates on mrc.project=<RAW org>, never mrc.repo', () => {
  const f = memberDockerFilter('acme.prod', 'apolline/claude')
  assert.ok(f.includes('label=mrc.project=acme.prod'), 'filters on the RAW org via mrc.project (no slug)')
  assert.ok(f.includes('label=mrc.member=apolline/claude'), 'and the specific handle')
  assert.ok(!f.some((x) => /mrc\.repo/.test(x)), 'NEVER mrc.repo — a cross-repo member carries mrc.repo=member.repo')
  // no handle → the #41 live-set probe (any member of the org)
  const any = memberDockerFilter('acme.prod')
  assert.ok(any.includes('label=mrc.member') && any.includes('label=mrc.project=acme.prod'))
  assert.ok(!any.some((x) => /mrc\.member=/.test(x)), 'no handle → any-member (no =value)')
})

// The single seam (arch A): the inner launches IN member.repo, and crossRepo is stamped AUTHORITATIVELY into the
// --member-def blob (the inner can't recompute it — argv[1] is member.repo, the team home isn't visible). The
// org in the blob is the TEAM org, never basename(member.repo).
test('#49 memberArgv: own-repo member launches in repoPath, crossRepo=false in the blob', () => {
  const teamRepo = '/home/alice/team'
  const m = { handle: 'ludivine/claude', repo: teamRepo }
  const argv = memberArgv(teamRepo, m, '/home/alice/team/.mrc/team.runtime.json', 'myorg')
  assert.equal(argv[1], teamRepo, 'inner launches in the team repo')
  const def = JSON.parse(Buffer.from(argv[argv.indexOf('--member-def') + 1], 'base64').toString('utf8'))
  assert.equal(def.crossRepo, false)
  assert.equal(def.org, 'myorg')
})
test('#49 memberArgv: cross-repo member launches in member.repo, crossRepo=true, org stays the TEAM org (never basename(member.repo))', () => {
  const teamRepo = '/home/alice/team', foreign = '/srv/shared'
  const m = { handle: 'apolline/claude', repo: foreign }
  const argv = memberArgv(teamRepo, m, '/home/alice/team/.mrc/team.runtime.json', 'myorg')
  assert.equal(argv[1], foreign, 'inner launches IN the authorized foreign repo (the single seam)')
  const def = JSON.parse(Buffer.from(argv[argv.indexOf('--member-def') + 1], 'base64').toString('utf8'))
  assert.equal(def.crossRepo, true, 'crossRepo stamped authoritatively (host-computed, blob-carried)')
  assert.equal(def.org, 'myorg', 'org is the TEAM org — NOT basename(/srv/shared)=shared')
  assert.notEqual(def.org, 'shared')
})

// memberWorkspaceVolumes mounts the member's OWN repo (its authorized member.repo), not the team home.
test('#49 memberWorkspaceVolumes: a cross-repo member mounts member.repo, not the passed repoPath', () => {
  const teamRepo = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-team-')))
  const foreign = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-foreign-')))
  try {
    const v = memberWorkspaceVolumes({ mount: 'rw', territory: '.', repo: foreign }, teamRepo)
    assert.deepEqual(v, ['-v', `${foreign}:/workspace`], 'mounts the member.repo, ignoring the team repoPath arg')
    // own-repo member (no .repo) still mounts the passed repoPath — byte-identical to today
    assert.deepEqual(memberWorkspaceVolumes({ mount: 'rw', territory: '.' }, teamRepo), ['-v', `${teamRepo}:/workspace`])
  } finally { fs.rmSync(teamRepo, { recursive: true, force: true }); fs.rmSync(foreign, { recursive: true, force: true }) }
})

// Pierre regressor #3: a foreign repo's .mrcrc must NOT be able to widen a cross-repo member's egress. belt-0
// (sanitizeRepoConfig) is an allowlist — `--web`/ALLOW_WEB are not in it — and mrc.js runs it against the inner's
// repoHint (= member.repo). Seed a foreign .mrcrc WITH --web and prove it's DROPPED (not merely absent).
test('#49 belt-0 door: a foreign repo .mrcrc `--web` / ALLOW_WEB is DROPPED (no cross-repo egress escalation)', () => {
  const foreign = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-foreign-mrcrc-')))
  try {
    fs.writeFileSync(join(foreign, '.mrcrc'), '--web\n--no-sound\nALLOW_WEB=1\n')
    const { flags: raw, envs: rawEnvs } = readMrcrc(join(foreign, '.mrcrc'))
    assert.ok(raw.includes('--web'), 'sanity: the foreign file really does request --web')
    const { flags, envs } = sanitizeRepoConfig(raw, rawEnvs)
    assert.ok(!flags.includes('--web') && !flags.includes('-w'), '--web is stripped by belt-0 (egress is never cedeable via a repo .mrcrc)')
    assert.ok(!('ALLOW_WEB' in envs), 'ALLOW_WEB env is refused too')
    assert.ok(flags.includes('--no-sound'), 'the benign local-UX flag survives (files+secrets+local-UX are cedeable; egress is not)')
  } finally { fs.rmSync(foreign, { recursive: true, force: true }) }
})

// Site 5: the HUMAN authorize control-plane (reposAction) over the host-only per-org set. A session can never
// call this — it's the CLI/dashboard path. Exercised against the real record with a scratch org + cleanup.
test('#49 reposAction: ls empty → add (realpaths + broad-guards) → ls shows it → rm → ls empty', () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'mrc-repos-')))
  const other = join(root, 'otherrepo'); fs.mkdirSync(other)
  const org = `test-repos-${process.pid}`
  try {
    assert.deepEqual(reposAction('ls', org, null).repos, [], 'starts empty (fail-closed default)')
    const add = reposAction('add', org, other)
    assert.equal(add.ok, true); assert.equal(add.added, other); assert.ok(add.repos.includes(other))
    assert.deepEqual([...loadAuthorizedRepos(org)], [other], 'persisted to the host record')
    // broad-guard surfaces as a clean error, not a throw
    const bad = reposAction('add', org, os.homedir())
    assert.equal(bad.ok, false); assert.match(bad.error, /home directory/)
    // missing arg → usage error, not a crash
    assert.equal(reposAction('add', org, null).ok, false)
    const rm = reposAction('rm', org, other)
    assert.equal(rm.ok, true); assert.deepEqual(rm.repos, [])
    assert.equal(reposAction('rm', org, other).ok, false, 'removing a non-member → ok:false (idempotent, honest)')
    assert.equal(reposAction('bogus', org, other).ok, false, 'unknown subcommand → error')
  } finally { fs.rmSync(root, { recursive: true, force: true }); try { fs.unlinkSync(_authPathForTest(org)) } catch {} }
})
