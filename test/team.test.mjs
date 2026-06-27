// Unit tests for the team launcher's pure pieces: per-member session ids, territorial mount flags,
// member env, persona assembly, and the persona-file write. (The container launch itself needs
// Docker and is validated via the rebuild recipe in docs.)
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import { join } from 'node:path'
import { parseRoster } from '../src/teams/roster.js'
import {
  memberSessionId, memberWorkspaceVolumes, memberEnv, personaForMember, writePersonaFile, orgDef, memberLaunch, cleanWorkerOutput,
  rosterFromDef, addMemberToRoster,
} from '../src/commands/team.js'

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

test('memberWorkspaceVolumes: whole-repo engineer gets rw /workspace', () => {
  const m = { mount: 'rw', territory: '.' }
  assert.deepEqual(memberWorkspaceVolumes(m, '/repo'), ['-v', '/repo:/workspace'])
})

test('memberWorkspaceVolumes: read-only member gets ro /workspace + rw .mrc', () => {
  const v = memberWorkspaceVolumes({ mount: 'ro', territory: 'client' }, '/repo')
  assert.deepEqual(v, ['-v', '/repo:/workspace:ro', '-v', '/repo/.mrc:/workspace/.mrc'])
})

test('memberWorkspaceVolumes: sub-tree engineer gets ro repo + rw .mrc + rw its territory', () => {
  const v = memberWorkspaceVolumes({ mount: 'rw', territory: 'client/src' }, '/repo')
  assert.deepEqual(v, [
    '-v', '/repo:/workspace:ro',
    '-v', '/repo/.mrc:/workspace/.mrc',
    '-v', '/repo/client/src:/workspace/client/src',
  ])
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

test('memberLaunch assembles env + territorial volumes + a stable session id', () => {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-team-'))
  const n = norm(); const w = find(n, 'engineer')
  const launch = memberLaunch(n, w, repo)
  assert.match(launch.sessionId, UUID_RE)
  assert.ok(launch.workspaceVolumes.includes('/repo/client/src:/workspace/client/src') ||
            launch.workspaceVolumes.some((x) => x.endsWith('client/src:/workspace/client/src')))
  assert.ok(launch.envFlags.some((x) => x.startsWith('MRC_PERSONA_FILE=')))
  assert.match(launch.persona, /You are @Ludivine/)
})
