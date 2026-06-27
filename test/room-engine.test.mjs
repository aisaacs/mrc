// Unit tests for the generalized room engine: directed @mention routing, role/name/handle
// resolution, multi-room isolation, the @user inbox, floor control, consult back-compat,
// brake/resume FIFO, and worker queueing. Driven through parseRoster so roster->engine is covered.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRoomEngine } from '../src/teams/room-engine.js'
import { parseRoster, teamRoomId, leadsRoomId } from '../src/teams/roster.js'

function seededRng(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }

// Build an engine from a roster JSON, with a recording transport. Binds live members to fake
// session ids ("sess:<handle>"). Returns helpers to drive and inspect it.
function harness(json, { bindAll = true, seed = 5 } = {}) {
  const sent = []      // { sessionId, frame }
  const appended = []  // { roomId, line }
  const notes = []
  let clock = 1_000
  const engine = createRoomEngine({
    send: (sessionId, frame) => sent.push({ sessionId, frame }),
    append: (roomId, line) => appended.push({ roomId, line }),
    notify: (msg) => notes.push(msg),
    now: () => clock,
    turnCap: 100,
  })
  const norm = parseRoster(json, { repo: '/tmp/repo', rng: seededRng(seed) })
  engine.defineOrg({ org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms })
  const sid = (handle) => `sess:${handle}`
  if (bindAll) for (const m of norm.members.filter((x) => x.tier === 'live')) engine.bindSession(m.handle, sid(m.handle))
  const handle = (role, team) => norm.members.find((m) => m.role === role && (!team || m.team === team)).handle
  const deliveriesTo = (h) => sent.filter((s) => s.sessionId === sid(h) && s.frame.type === 'deliver').map((s) => s.frame.text)
  const directivesTo = (h) => sent.filter((s) => s.sessionId === sid(h) && s.frame.type === 'directive').map((s) => s.frame.text)
  return { engine, norm, sent, appended, notes, sid, handle, deliveriesTo, directivesTo, tick: (n) => { clock += n }, clock: () => clock }
}

const TEAM = {
  org: 'shop', repo: '/tmp/repo',
  teams: [{
    name: 'client', territory: 'client', members: [
      { role: 'architect', backend: 'claude', lead: true },
      { role: 'engineer', backend: 'claude' },
      { role: 'critic', backend: 'claude' },
    ],
  }],
}

test('engine: directed @role delivery hits only the addressed member', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), engineer = h.handle('engineer'), critic = h.handle('critic')
  const r = h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@engineer please implement the login form' })
  assert.equal(r.ok, true)
  assert.equal(h.deliveriesTo(engineer).length, 1)
  assert.equal(h.deliveriesTo(critic).length, 0, 'critic not addressed -> not delivered')
  assert.match(h.deliveriesTo(engineer)[0], /Peer \(@.*Architect.*\) says/i)
  assert.match(h.deliveriesTo(engineer)[0], /\[room client\]/, 'team room tag present')
})

test('engine: @firstname and @handle both resolve', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), critic = h.handle('critic')
  const criticFirst = h.norm.members.find((m) => m.handle === critic).first
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: `@${criticFirst} review this` })
  assert.equal(h.deliveriesTo(critic).length, 1, 'first-name addressing works')
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: `@${critic} again` })
  assert.equal(h.deliveriesTo(critic).length, 2, 'full handle addressing works')
})

test('engine: directed-only floor control — no mention in a 3+ room delivers to no one', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect')
  const r = h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: 'thinking out loud, no addressee' })
  assert.deepEqual(r.delivered, [])
  assert.equal(h.sent.filter((s) => s.frame.type === 'deliver').length, 0)
})

test('engine: 2-member consult back-compat — no mention delivers to the other; no room tag', () => {
  const json = { org: 'duo', teams: [{ name: 'pair', members: [
    { role: 'architect', backend: 'claude', name: 'alice', lead: true },
    { role: 'engineer', backend: 'claude', name: 'bob' },
  ] }] }
  const h = harness(json)
  // Re-tag the room as consult to exercise the legacy framing path.
  const room = h.engine.getRoom(teamRoomId('duo', 'pair')); room.kind = 'consult'
  h.engine.route({ fromHandle: 'alice/claude', roomId: room.roomId, text: 'what auth format?' })
  const toBob = h.sent.filter((s) => s.sessionId === 'sess:bob/claude' && s.frame.type === 'deliver')
  assert.equal(toBob.length, 1, 'delivered to the other member with no explicit mention')
  assert.doesNotMatch(toBob[0].frame.text, /\[room /, 'consult kind omits the room tag')
})

test('engine: @user routes to the inbox + notify; answerUser sends [Human reply] back', () => {
  const h = harness(TEAM)
  const engineer = h.handle('engineer')
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user should errors be toasts or inline?' })
  const inbox = h.engine.status().userInbox
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].from, engineer)
  assert.ok(h.notes.some((n) => /needs you/.test(n)))
  const res = h.engine.answerUser(0, 'inline')
  assert.equal(res.ok, true)
  assert.match(h.directivesTo(engineer)[0], /\[Human reply\]: inline/)
})

test('engine: multi-room — a lead is in team room + leads room; routing is isolated per room', () => {
  const json = {
    org: 'shop',
    teams: [
      { name: 'client', members: [ { role: 'architect', backend: 'claude', name: 'roland', lead: true }, { role: 'engineer', backend: 'claude', name: 'ludivine' } ] },
      { name: 'api', members: [ { role: 'architect', backend: 'claude', name: 'gaston', lead: true }, { role: 'engineer', backend: 'claude', name: 'thierry' } ] },
    ],
  }
  const h = harness(json)
  const roland = 'roland/claude', gaston = 'gaston/claude', ludivine = 'ludivine/claude', thierry = 'thierry/claude'
  // Both architects are in two rooms; the engineers in one each.
  assert.equal(h.engine.roomsForHandle(roland).length, 2)
  assert.equal(h.engine.roomsForHandle(ludivine).length, 1)

  // Roland talks to Gaston in the LEADS room — must not reach the client engineer.
  h.engine.route({ fromHandle: roland, roomId: leadsRoomId('shop'), text: '@gaston what is the token TTL?' })
  assert.equal(h.deliveriesTo(gaston).length, 1)
  assert.equal(h.deliveriesTo(ludivine).length, 0, 'leads-room traffic stays out of the client team room')
  assert.match(h.deliveriesTo(gaston)[0], /\[room shop--leads\]|\[room .*leads\]/)

  // Ambiguous room (roland is in 2) without a roomId must be rejected.
  const amb = h.engine.route({ fromHandle: roland, text: 'no room specified' })
  assert.equal(amb.ok, false)
  assert.match(amb.error, /ambiguous room/)
})

test('engine: a engineer cannot reach another team (not a member of that room)', () => {
  const json = {
    org: 'shop',
    teams: [
      { name: 'client', members: [ { role: 'architect', backend: 'claude', name: 'roland', lead: true }, { role: 'engineer', backend: 'claude', name: 'ludivine' } ] },
      { name: 'api', members: [ { role: 'architect', backend: 'claude', name: 'gaston', lead: true } ] },
    ],
  }
  const h = harness(json)
  const r = h.engine.route({ fromHandle: 'ludivine/claude', roomId: leadsRoomId('shop'), text: '@gaston hi' })
  assert.equal(r.ok, false)
  assert.match(r.error, /not a member of that room/)
})

test('engine: brake holds directed messages FIFO; resume delivers them in order', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), engineer = h.handle('engineer')
  const room = h.engine.getRoom(teamRoomId('shop', 'client'))
  h.engine.doBrake(room)
  h.engine.route({ fromHandle: arch, roomId: room.roomId, text: '@engineer step one' })
  h.engine.route({ fromHandle: arch, roomId: room.roomId, text: '@engineer step two' })
  assert.equal(h.deliveriesTo(engineer).length, 0, 'held while paused')
  h.engine.doResume(room)
  const got = h.deliveriesTo(engineer)
  assert.equal(got.length, 2)
  assert.match(got[0], /step one/); assert.match(got[1], /step two/)
})

test('engine: turn-cap check-in pauses the room at the cap', () => {
  const json = { org: 'shop', teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'a', lead: true }, { role: 'engineer', backend: 'claude', name: 'b' },
  ] }] }
  const sent = []
  const engine = createRoomEngine({ send: (s, f) => sent.push({ s, f }), append: () => {}, notify: () => {}, turnCap: 2 })
  const norm = parseRoster(json, { repo: '/tmp', rng: seededRng(1) })
  engine.defineOrg({ org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms })
  engine.bindSession('a/claude', 's1'); engine.bindSession('b/claude', 's2')
  const room = engine.getRoom(teamRoomId('shop', 'client'))
  engine.route({ fromHandle: 'a/claude', roomId: room.roomId, text: '@b one' })
  let r = engine.route({ fromHandle: 'a/claude', roomId: room.roomId, text: '@b two' })
  assert.equal(room.state, 'Paused')
  assert.equal(room.pauseReason, 'turnCap')
})

test('engine: worker (non-Claude) member is queued, not delivered live', () => {
  const json = { org: 'shop', teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'engineer', backend: 'codex', name: 'thierry' },
  ] }] }
  const h = harness(json)
  const r = h.engine.route({ fromHandle: 'roland/claude', roomId: teamRoomId('shop', 'client'), text: '@thierry build the parser' })
  assert.equal(r.delivered[0].status, 'queued', 'worker mention is queued')
  assert.equal(h.engine.status().workerQueue, 1)
  assert.equal(h.sent.filter((s) => s.frame.type === 'deliver').length, 0, 'nothing sent to a live socket')
})

test('engine: steer sends [Human directive] to all room members and clears held', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), engineer = h.handle('engineer'), critic = h.handle('critic')
  const room = h.engine.getRoom(teamRoomId('shop', 'client'))
  h.engine.doBrake(room)
  h.engine.route({ fromHandle: arch, roomId: room.roomId, text: '@engineer wrong path' })
  const res = h.engine.doSteer(room, 'all', 'switch to OAuth')
  assert.equal(room.state, 'Running')
  assert.ok(h.directivesTo(engineer).some((t) => /switch to OAuth/.test(t)))
  assert.ok(h.directivesTo(critic).some((t) => /switch to OAuth/.test(t)))
  assert.equal(h.deliveriesTo(engineer).length, 0, 'held backlog dropped by steer')
})

test('engine: @user mid-sentence is a reference, not a question (no inbox spam)', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), engineer = h.handle('engineer')
  // Addresses the engineer; merely references @user in prose -> must NOT become an inbox question.
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@engineer kickoff — scope is locked by @user, build the spine' })
  assert.equal(h.engine.status().userInbox.length, 0, 'a passing @user reference does not hit the inbox')
  assert.equal(h.deliveriesTo(engineer).length, 1, 'still delivered to the engineer')
  // A leading @user IS a real question.
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@user should pieces be animals or candy?' })
  assert.equal(h.engine.status().userInbox.length, 1, 'leading @user reaches the inbox')
})

test('engine: multi-room lead — room inferred from the @mentioned target', () => {
  const json = {
    org: 'shop',
    teams: [
      { name: 'client', members: [ { role: 'architect', backend: 'claude', name: 'roland', lead: true }, { role: 'engineer', backend: 'claude', name: 'ludivine' } ] },
      { name: 'api', members: [ { role: 'architect', backend: 'claude', name: 'gaston', lead: true } ] },
    ],
  }
  const h = harness(json)
  // No roomId given. "@ludivine" only resolves in the client team room -> inferred there.
  h.engine.route({ fromHandle: 'roland/claude', text: '@ludivine start the form' })
  assert.equal(h.deliveriesTo('ludivine/claude').length, 1)
  // "@gaston" only resolves in the leads room -> inferred there.
  h.engine.route({ fromHandle: 'roland/claude', text: '@gaston sync on the contract' })
  assert.equal(h.deliveriesTo('gaston/claude').length, 1)
})

test('engine: soft room hint by team name resolves the room', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), engineer = h.handle('engineer')
  const r = h.engine.route({ fromHandle: arch, room: 'client', text: '@engineer go' })
  assert.equal(r.ok, true)
  assert.equal(h.deliveriesTo(engineer).length, 1)
})

test('engine: redefining an org prunes removed members and rooms (no ghosts)', () => {
  const sent = []
  const engine = createRoomEngine({ send: (s, f) => sent.push({ s, f }), append: () => {}, notify: () => {} })
  const v1 = parseRoster({ org: 'shop', teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'engineer', backend: 'claude', name: 'ludivine' },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }] }, { repo: '/tmp' })
  engine.defineOrg({ org: v1.org, repo: v1.repo, members: v1.members, rooms: v1.rooms })
  assert.equal(engine.status().members.length, 3)
  // Redefine with the critic removed.
  const v2 = parseRoster({ org: 'shop', teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'engineer', backend: 'claude', name: 'ludivine' },
  ] }] }, { repo: '/tmp' })
  engine.defineOrg({ org: v2.org, repo: v2.repo, members: v2.members, rooms: v2.rooms })
  const handles = engine.status().members.map((m) => m.handle)
  assert.equal(handles.length, 2, 'pruned to the new member set')
  assert.ok(!handles.includes('pierre/claude'), 'removed member is gone')
})

test('engine: unresolved mentions are reported, not silently dropped', () => {
  const h = harness(TEAM)
  const r = h.engine.route({ fromHandle: h.handle('architect'), roomId: teamRoomId('shop', 'client'), text: '@nobody hello' })
  assert.deepEqual(r.unresolved, ['nobody'])
})
