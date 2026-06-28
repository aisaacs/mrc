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
    append: (roomId, line, meta) => appended.push({ roomId, line, meta }),
    notify: (msg) => notes.push(msg),
    now: () => clock,
    turnCap: 100,
  })
  const norm = parseRoster(json, { repo: '/tmp/repo', rng: seededRng(seed) })
  engine.defineOrg({ org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms })
  const sid = (handle) => `sess:${handle}`
  if (bindAll) for (const m of norm.members.filter((x) => x.tier === 'live')) engine.bindSession(norm.org, m.handle, sid(m.handle))
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
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user should errors be toasts or inline?', kind: 'question' })
  const inbox = h.engine.status().userInbox
  assert.equal(inbox.length, 1)
  assert.equal(inbox[0].from, engineer)
  assert.equal(inbox[0].type, 'question')
  assert.ok(h.notes.some((n) => /needs you/.test(n)))   // a question nags ("needs you"); a notification would be "FYI"
  const res = h.engine.answerUser(inbox[0].id, 'inline')
  assert.equal(res.ok, true)
  assert.match(h.directivesTo(engineer)[0], /\[Human reply to "[^"]*"\]: inline/)
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
  engine.bindSession('shop', 'a/claude', 's1'); engine.bindSession('shop', 'b/claude', 's2')
  const room = engine.getRoom(teamRoomId('shop', 'client'))
  engine.route({ fromHandle: 'a/claude', roomId: room.roomId, text: '@b one' })
  let r = engine.route({ fromHandle: 'a/claude', roomId: room.roomId, text: '@b two' })
  assert.equal(room.state, 'Paused')
  assert.equal(room.pauseReason, 'turnCap')
})

test('engine: turn-cap pause raises a resolvable @you item — dedup + resolve-on-resume + reply-resumes (#35)', () => {
  const json = { org: 'shop', teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'a', lead: true }, { role: 'engineer', backend: 'claude', name: 'b' }, { role: 'critic', backend: 'claude', name: 'c' },
  ] }] }
  const ev = []; const sent = []
  const engine = createRoomEngine({ send: (s, f) => sent.push({ s, f }), append: () => {}, notify: () => {}, onInbox: (e) => ev.push(e), turnCap: 2 })
  const norm = parseRoster(json, { repo: '/tmp', rng: seededRng(1) })
  engine.defineOrg({ org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms })
  for (const m of norm.members) engine.bindSession('shop', m.handle, 's-' + m.handle)
  const room = engine.getRoom(teamRoomId('shop', 'client'))
  const inbox = () => engine.status().userInbox
  engine.route({ fromHandle: 'a/claude', roomId: room.roomId, text: '@b one' })
  engine.route({ fromHandle: 'b/claude', roomId: room.roomId, text: '@c two' })   // hits cap=2 → pause
  assert.equal(room.state, 'Paused')
  const item = inbox().find((x) => x.pauseRoom === room.roomId)
  assert.ok(item, 'a turn-cap @you item was raised')
  assert.equal(item.type, 'question', 'badges (resume is an action)')
  assert.equal(ev.filter((e) => e.kind === 'new').length, 1, 'exactly one new inbox event (→ telegram)')
  // dedup: held messages while paused must NOT re-create the item
  engine.route({ fromHandle: 'c/claude', roomId: room.roomId, text: '@a more' })
  assert.equal(inbox().filter((x) => x.pauseRoom).length, 1, 'still ONE item while paused')
  // resolve-on-resume (H4): resuming clears the item + fires a resolved event
  engine.doResume(room)
  assert.equal(room.state, 'Running')
  assert.equal(inbox().find((x) => x.id === item.id).answered, true, 'resolved on resume — no stale paused item')
  assert.equal(ev.filter((e) => e.kind === 'resolved').length, 1, 'one resolved event (→ telegram edit)')
  // new pause episode raises a FRESH item; replying to it resumes the room
  engine.route({ fromHandle: 'a/claude', roomId: room.roomId, text: '@b again' })
  engine.route({ fromHandle: 'b/claude', roomId: room.roomId, text: '@c again' })
  const item2 = inbox().find((x) => x.pauseRoom && !x.answered)
  assert.ok(item2 && item2.id !== item.id, 'fresh item for the new episode')
  const ar = engine.answerUser(item2.id, 'focus on the API next')
  assert.ok(ar.ok && room.state === 'Running', 'reply resumed the room')
  assert.ok(ar.resumed && ar.steered, 'reply flagged resumed + steered (not a dropped answer)')
  assert.equal(inbox().find((x) => x.id === item2.id).answer, 'focus on the API next', 'the reply TEXT is recorded, not dropped')
  assert.ok(sent.some((x) => /Human directive/.test(x.f?.text || '') && /focus on the API next/.test(x.f?.text || '')), 'the reply was steered into the room as a directive (#35 option a)')
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

test('engine: opening-line addressee gate — a greeting before the @mention still addresses (#10)', () => {
  // The leading-run rule allows light greeting/connector words before the @mention, so natural
  // openers deliver in a 3+ member room (where directed-only floor control otherwise drops them).
  for (const text of ['Hey @engineer, can you review?', 'ok @engineer review this', 'Quick one @engineer: ship it', 'thanks, @engineer — go']) {
    const h = harness(TEAM)
    const r = h.engine.route({ fromHandle: h.handle('architect'), roomId: teamRoomId('shop', 'client'), text })
    assert.equal(h.deliveriesTo(h.handle('engineer')).length, 1, `delivered: ${text}`)
    assert.deepEqual(r.unresolved, [], `no spurious unresolved: ${text}`)
  }
})

test('engine: answerUser/doSteer carry a [via Telegram] audit tag when sourced from Telegram (#12 step 5)', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), engineer = h.handle('engineer')
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user toasts?', kind: 'question' })
  const id = h.engine.status().userInbox[0].id
  h.engine.answerUser(id, 'inline', { via: 'telegram' })
  assert.match(h.directivesTo(engineer).at(-1), /\[Human reply via Telegram to "[^"]*"\]: inline/)
  // a dashboard answer (no via) stays the plain marker
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user again?', kind: 'question' })
  const id2 = h.engine.status().userInbox.at(-1).id
  h.engine.answerUser(id2, 'yes')
  assert.match(h.directivesTo(engineer).at(-1), /\[Human reply to "[^"]*"\]: yes/)
  // doSteer via telegram → directive audit tag
  h.engine.doSteer(h.engine.getRoom(teamRoomId('shop', 'client')), 'engineer', 'ship it', { via: 'telegram' })
  assert.match(h.directivesTo(engineer).at(-1), /\[Human directive via Telegram\]: ship it/)
})

test('engine: inbox items carry a stable unique id; addressing is by id, not array position (#12 step 1)', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect')
  for (const t of ['@user a?', '@user b?', '@user c?']) h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: t, kind: 'question' })
  const ids = h.engine.status().userInbox.map((x) => x.id)
  assert.equal(new Set(ids).size, 3, 'ids are unique')
  // Resolve the FIRST item, then answer the THIRD by its id — must still hit the third (id, not index).
  h.engine.answerUser(ids[0], 'ans-a')
  const r = h.engine.answerUser(ids[2], 'ans-c')
  assert.equal(r.ok, true)
  const byText = Object.fromEntries(h.engine.status().userInbox.map((x) => [x.text, x]))
  assert.equal(byText['@user c?'].answer, 'ans-c')
  assert.equal(byText['@user b?'].answered, false, 'the untouched middle item is unaffected')
})

test('engine: inbox item type follows the tool — ask_user=question, plain @user=notification (#11)', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect')
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@user should errors be toasts?', kind: 'question' })
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@user heads up — deploy finished' })   // no kind → notification
  const inbox = h.engine.status().userInbox
  assert.equal(inbox.length, 2)
  assert.equal(inbox[0].type, 'question', 'ask_user (kind=question) → question')
  assert.equal(inbox[1].type, 'notification', 'plain @user (no kind) → notification')
})

test('engine: @user line carries a visible [#id]; the reply carries (re #id) for traceability (#18)', () => {
  const h = harness(TEAM)
  const engineer = h.handle('engineer')
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user toasts?', kind: 'question' })
  const item = h.engine.status().userInbox[0]
  const qline = h.appended.find((a) => /toasts\?/.test(a.line))
  assert.match(qline.line, new RegExp(`\\[#${item.id}\\]$`), 'question thread line ends with [#id]')
  h.engine.answerUser(item.id, 'inline')
  const rline = h.appended.find((a) => /HUMAN -> .*: inline/.test(a.line))
  assert.match(rline.line, new RegExp(`\\(re #${item.id}\\)$`), 'reply thread line ends with (re #id)')
})

test('engine: the trusted qid/reqid is emitted as APPEND META, not just in the text (#18 spoof-proof)', () => {
  const h = harness(TEAM)
  const engineer = h.handle('engineer')
  // A member-to-member message whose TEXT ends in a fake "[#9]" must carry NO qid meta — so the dashboard
  // can never anchor it. The trusted qid only rides the actual @user-question append.
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@critic see [#9]' })
  const spoof = h.appended.find((a) => /see \[#9\]/.test(a.line))
  assert.ok(spoof && (spoof.meta == null || spoof.meta.qid == null), 'a member line ending in [#9] carries no qid meta → never anchorable')

  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user real question?', kind: 'question' })
  const item = h.engine.status().userInbox.find((x) => /real question/.test(x.text))
  const qline = h.appended.find((a) => /real question/.test(a.line))
  assert.equal(qline.meta?.qid, item.id, 'the genuine @user question carries qid meta = its inbox id')
  h.engine.answerUser(item.id, 'ok')
  const rline = h.appended.find((a) => /HUMAN -> .*: ok/.test(a.line))
  assert.equal(rline.meta?.reqid, item.id, 'the human reply carries reqid meta = the answered id')
})

test('engine: answerUser records which surface resolved it (answeredVia) for cross-surface close (#24)', () => {
  const h = harness(TEAM)
  const engineer = h.handle('engineer')
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user A?', kind: 'question' })
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user B?', kind: 'question' })
  const [a, b] = h.engine.status().userInbox
  h.engine.answerUser(a.id, 'from the dashboard')
  h.engine.answerUser(b.id, 'from my phone', { via: 'telegram' })
  const inbox = h.engine.status().userInbox
  assert.equal(inbox.find((x) => x.id === a.id).answeredVia, 'dashboard', 'a plain answer is tagged dashboard')
  assert.equal(inbox.find((x) => x.id === b.id).answeredVia, 'telegram', 'a Telegram answer is tagged telegram (so the web panel can say "via Telegram")')
  // The stale-guard still rejects a SECOND answer (the double-answer the cross-surface close prevents).
  const late = h.engine.answerUser(b.id, 'late dashboard reply')
  assert.equal(late.ok, false); assert.equal(late.stale, true)
})

test('engine: a NOTIFICATION is replyable — answerUser routes exactly one [Human reply] (#15)', () => {
  const h = harness(TEAM)
  const engineer = h.handle('engineer')
  h.engine.route({ fromHandle: engineer, roomId: teamRoomId('shop', 'client'), text: '@user heads up — deploy done' })   // notification (no kind)
  const item = h.engine.status().userInbox[0]
  assert.equal(item.type, 'notification')
  const before = h.directivesTo(engineer).length
  const r = h.engine.answerUser(item.id, 'thanks, noted')
  assert.equal(r.ok, true)
  assert.equal(h.directivesTo(engineer).length, before + 1, 'exactly one [Human reply] routed')
  assert.match(h.directivesTo(engineer).at(-1), /\[Human reply to "[^"]*"\]: thanks, noted/)
  // replying again is stale-guarded (no double-route), same as a question
  assert.equal(h.engine.answerUser(item.id, 'again').stale, true)
})

test('engine: dismissUser clears WITHOUT routing a reply; answerUser routes [Human reply] (#11)', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect')
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@user q?', kind: 'question' })
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@user fyi' })
  const byId = () => Object.fromEntries(h.engine.status().userInbox.map((x) => [x.text, x]))
  const qId = byId()['@user q?'].id, fyiId = byId()['@user fyi'].id   // STABLE ids, not array indices
  const before = h.directivesTo(arch).length
  const d = h.engine.dismissUser(fyiId)
  assert.equal(d.ok, true)
  assert.equal(byId()['@user fyi'].dismissed, true)
  assert.equal(h.directivesTo(arch).length, before, 'dismiss must NOT route a reply')
  // answering a DISMISSED item is rejected as stale and routes nothing (H4 cross-surface double-route guard)
  const ad = h.engine.answerUser(fyiId, 'late reply')
  assert.equal(ad.ok, false); assert.equal(ad.stale, true)
  assert.equal(h.directivesTo(arch).length, before, 'answering a dismissed item routes zero directives')
  h.engine.answerUser(qId, 'yes, toasts')
  assert.equal(byId()['@user q?'].answered, true)
  assert.ok(h.directivesTo(arch).some((t) => /\[Human reply to "[^"]*"\]: yes, toasts/.test(t)), 'answer routes a [Human reply]')
  // answering again is rejected as stale (already answered)
  assert.equal(h.engine.answerUser(qId, 'again').stale, true)
  // reopen undoes a dismiss → actionable again (recovers a misclick)
  h.engine.reopenUser(fyiId)
  assert.equal(byId()['@user fyi'].dismissed, false)
})

test('engine: opening-line addressee gate — a buried @mention is a reference, not delivery (#10)', () => {
  const h = harness(TEAM)
  const engineer = h.handle('engineer'), critic = h.handle('critic')
  // @critic appears only AFTER substantive words -> a reference: no delivery, and NOT reported as an
  // unknown addressee (the spurious-notice noise #10 kills).
  const r = h.engine.route({ fromHandle: h.handle('architect'), roomId: teamRoomId('shop', 'client'), text: 'I rewrote it the way @critic suggested earlier' })
  assert.equal(h.deliveriesTo(critic).length, 0, 'buried @critic not delivered')
  assert.equal(h.deliveriesTo(engineer).length, 0)
  assert.deepEqual(r.unresolved, [], 'buried reference is not an unresolved addressee')
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

test('engine: notifyRoom announces to existing live members, not the new/excepted one', () => {
  const h = harness(TEAM)
  const arch = h.handle('architect'), engineer = h.handle('engineer'), critic = h.handle('critic')
  const n = h.engine.notifyRoom(teamRoomId('shop', 'client'), '[Team update] @Newbie joined', { except: critic })
  const noticesTo = (hh) => h.sent.filter((s) => s.sessionId === h.sid(hh) && s.frame.type === 'notice' && /Newbie/.test(s.frame.text)).length
  assert.equal(n, 2)
  assert.equal(noticesTo(arch), 1)
  assert.equal(noticesTo(engineer), 1)
  assert.equal(noticesTo(critic), 0, 'excepted member not notified')
})

test('engine: unresolved mentions are reported, not silently dropped', () => {
  const h = harness(TEAM)
  const r = h.engine.route({ fromHandle: h.handle('architect'), roomId: teamRoomId('shop', 'client'), text: '@nobody hello' })
  assert.deepEqual(r.unresolved, ['nobody'])
})

test('engine: accented member resolves with or without the accent (and stays addressable)', () => {
  const json = { org: 'shop', teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'critic', backend: 'claude', name: 'Côme' },
  ] }] }
  const h = harness(json)
  const arch = h.handle('architect')
  // Accented as typed in the roster — both the accented and the de-accented mention must reach Côme.
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@Côme punch up the logo' })
  h.engine.route({ fromHandle: arch, roomId: teamRoomId('shop', 'client'), text: '@come and the favicon' })
  assert.equal(h.deliveriesTo('côme/claude').length, 2, 'both @Côme and @come delivered')
})

test('engine: an @user-only message from a multi-room lead routes to the leads room, not "ambiguous"', () => {
  const json = { org: 'shop', teams: [
    { name: 'client', members: [ { role: 'architect', backend: 'claude', name: 'roland', lead: true }, { role: 'engineer', backend: 'claude', name: 'ludivine' } ] },
    { name: 'api', members: [ { role: 'architect', backend: 'claude', name: 'gaston', lead: true } ] },
  ] }
  const h = harness(json)
  // roland is in the client team room AND the leads room. A bare "@user …" used to error "ambiguous
  // room" (no peer target to infer from); it must go to the leads room where @user lives.
  assert.equal(h.engine.findRoom('roland/claude', null, '@user should we ship?')?.roomId, leadsRoomId('shop'))
  const r = h.engine.route({ fromHandle: 'roland/claude', text: '@user should we ship?' })
  assert.equal(r.ok, true, 'no ambiguous-room error')
  assert.equal(r.toUser, true, 'reaches the human inbox')
  assert.equal(h.engine.status().userInbox.length, 1)
})
