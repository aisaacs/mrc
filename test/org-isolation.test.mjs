// Containment regression: ONE daemon hosting TWO orgs that share member handles must keep them fully
// isolated — no cross-org delivery, no @user-inbox bleed, no clobbered bindings, no spurious
// "ambiguous room". This is the org-qualified-key fix (#8). It FAILS on the pre-fix engine (which
// keyed members by bare handle in a single global namespace, so org B clobbered org A).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoomEngine } from '../src/teams/room-engine.js'
import { parseRoster, teamRoomId, leadsRoomId } from '../src/teams/roster.js'
import { memberSessionId } from '../src/teams/session-id.js'

// Two orgs, IDENTICAL pinned handles (roland/ludivine/pierre, all /claude). The collision is the
// whole point — distinct orgs, same bare handles.
const rosterFor = (org) => parseRoster({
  org, teams: [{ name: 'core', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'engineer', backend: 'claude', name: 'ludivine' },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }],
}, { repo: `/tmp/${org}` })

function twoOrgEngine() {
  const sent = []  // { sessionId, frame }
  const engine = createRoomEngine({ send: (sessionId, frame) => sent.push({ sessionId, frame }), append: () => {}, notify: () => {} })
  const A = rosterFor('alpha'), B = rosterFor('beta')
  engine.defineOrg({ org: A.org, repo: A.repo, members: A.members, rooms: A.rooms })
  engine.defineOrg({ org: B.org, repo: B.repo, members: B.members, rooms: B.rooms })
  // Session ids are the REAL memberSessionId(org, handle) — org-specific even though handles collide.
  const sid = (org, handle) => memberSessionId(org, handle)
  for (const org of ['alpha', 'beta']) for (const h of ['roland/claude', 'ludivine/claude', 'pierre/claude']) engine.bindSession(org, h, sid(org, h))
  const deliveriesTo = (org, h) => sent.filter((s) => s.sessionId === sid(org, h) && s.frame.type === 'deliver').map((s) => s.frame.text)
  return { engine, sent, sid, deliveriesTo }
}

test('org-isolation: a session is in ONLY its own org rooms (collision does not merge them)', () => {
  const { engine, sid } = twoOrgEngine()
  const aRooms = engine.roomsForSession(sid('alpha', 'roland/claude'))
  const bRooms = engine.roomsForSession(sid('beta', 'roland/claude'))
  assert.ok(aRooms.length > 0 && bRooms.length > 0)
  assert.ok(aRooms.every((r) => r.org === 'alpha'), 'alpha roland sees only alpha rooms')
  assert.ok(bRooms.every((r) => r.org === 'beta'), 'beta roland sees only beta rooms')
  // and they are genuinely disjoint room ids
  const aIds = new Set(aRooms.map((r) => r.roomId))
  assert.ok(bRooms.every((r) => !aIds.has(r.roomId)))
})

test('org-isolation: NO cross-org delivery — @pierre in alpha reaches alpha pierre only', () => {
  const { engine, sid, deliveriesTo } = twoOrgEngine()
  engine.route({ sessionId: sid('alpha', 'roland/claude'), roomId: teamRoomId('alpha', 'core'), text: '@pierre review the diff' })
  assert.equal(deliveriesTo('alpha', 'pierre/claude').length, 1, 'alpha pierre got it')
  assert.equal(deliveriesTo('beta', 'pierre/claude').length, 0, 'beta pierre did NOT — no bleed')
})

test('org-isolation: NO @user-inbox bleed — each org sees only its own questions', () => {
  const { engine, sid } = twoOrgEngine()
  engine.route({ sessionId: sid('alpha', 'roland/claude'), text: '@user ship alpha?' })  // -> alpha leads room
  engine.route({ sessionId: sid('beta', 'roland/claude'), text: '@user ship beta?' })    // -> beta leads room
  const inbox = engine.status().userInbox
  assert.equal(inbox.length, 2)
  assert.equal(inbox.filter((x) => x.org === 'alpha').length, 1)
  assert.equal(inbox.filter((x) => x.org === 'beta').length, 1)
  assert.match(inbox.find((x) => x.org === 'alpha').text, /alpha/)
  assert.match(inbox.find((x) => x.org === 'beta').text, /beta/)
})

test('org-isolation: redefining org B does NOT clobber org A members or their live bindings', () => {
  const { engine, sid } = twoOrgEngine()
  const before = engine.memberByHandle('roland/claude', 'alpha')
  assert.equal(before.org, 'alpha')
  assert.equal(before.sessionId, sid('alpha', 'roland/claude'), 'alpha roland bound before')
  // Redefine beta (e.g. add-member / reload). Must not touch alpha.
  const B2 = rosterFor('beta')
  engine.defineOrg({ org: B2.org, repo: B2.repo, members: B2.members, rooms: B2.rooms })
  const after = engine.memberByHandle('roland/claude', 'alpha')
  assert.equal(after.org, 'alpha')
  assert.equal(after.sessionId, sid('alpha', 'roland/claude'), 'alpha roland STILL bound after beta redefine')
})

test('org-isolation: @role / @name resolve to the SAME-org member within each room', () => {
  const { engine } = twoOrgEngine()
  const aRoom = engine.getRoom(teamRoomId('alpha', 'core'))
  const bRoom = engine.getRoom(teamRoomId('beta', 'core'))
  assert.equal(engine.resolveInRoom(aRoom, 'critic'), 'pierre/claude')
  assert.equal(engine.resolveInRoom(aRoom, 'roland'), 'roland/claude')
  assert.equal(engine.memberByHandle(engine.resolveInRoom(aRoom, 'critic'), 'alpha').org, 'alpha')
  assert.equal(engine.memberByHandle(engine.resolveInRoom(bRoom, 'critic'), 'beta').org, 'beta')
})

test('org-isolation: a single-room member never gets "ambiguous room" on a plain send', () => {
  const { engine, sid } = twoOrgEngine()
  // ludivine (engineer) is in exactly one room per org — a plain send must resolve, not error.
  const r = engine.route({ sessionId: sid('alpha', 'ludivine/claude'), text: 'status: spine is up' })
  assert.equal(r.ok, true)
  assert.notEqual(r.error, 'ambiguous room — name the team or room (e.g. room:"leads")')
})

test('org-isolation: removeOrg purges ONE org entirely (members/rooms/inbox), leaves the other intact (#13)', () => {
  const { engine, sid } = twoOrgEngine()
  // seed an @user question in each org's inbox
  engine.route({ sessionId: sid('alpha', 'roland/claude'), text: '@user a?', kind: 'question' })
  engine.route({ sessionId: sid('beta', 'roland/claude'), text: '@user b?', kind: 'question' })
  engine.removeOrg('alpha')
  const st = engine.status()
  assert.ok(st.members.every((m) => m.org !== 'alpha'), 'no alpha members survive')
  assert.ok(st.rooms.every((r) => r.org !== 'alpha'), 'no alpha rooms survive')
  assert.ok(st.userInbox.every((x) => x.org !== 'alpha'), 'no alpha inbox items survive')
  assert.ok(st.members.some((m) => m.org === 'beta'), 'beta is untouched')
  assert.equal(st.userInbox.filter((x) => x.org === 'beta').length, 1)
  // idempotent: removing again is a clean no-op
  assert.equal(engine.removeOrg('alpha').ok, true)
  assert.equal(engine.removeOrg('never-existed').ok, true)
})
