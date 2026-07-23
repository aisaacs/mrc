// Socket-level integration test for team rooms on the real daemon: boots startRoomDaemon, defines an
// org over the control socket, connects member relay sockets, and exercises directed @delivery, the
// @user inbox round-trip, and brake/resume — over the actual newline-JSON wire protocol.
import test, { afterEach } from 'node:test'
import { controlSecret } from '../src/rooms.js'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { startRoomDaemon as _startRoomDaemon } from '../src/proxies/room-daemon.js'
import { findFreePort } from '../src/ports.js'
import { parseRoster, teamRoomId } from '../src/teams/roster.js'
import { memberSessionId } from '../src/teams/session-id.js'
import { saveSessionRecord, loadSessionRecord } from '../src/session-record.js'
import { createInboundDedup } from '../container/mrc-channel-tools.js'

// TEARDOWN DISCIPLINE (see daemon-classify.test.mjs): a test that throws before its daemon.stop() leaks the
// relay/control servers + rolling retry timer + (on macOS) the caffeinate child, and node --test wedges at exit.
// Shadow the factory to register every in-process daemon and stop them all after each test, pass or throw.
const _liveDaemons = new Set()
const _testSocks = new Set()   // track every relay socket a test opens so an assertion FAILURE (which skips the test's own cleanup) can't leak a handle and wedge node --test at exit (the macOS-test-hang class)
function startRoomDaemon(opts) { const d = _startRoomDaemon(opts); if (d) _liveDaemons.add(d); return d }
afterEach(() => { for (const s of _testSocks) { try { s.destroy() } catch {} } _testSocks.clear(); for (const d of _liveDaemons) { try { d.stop?.() } catch {} } _liveDaemons.clear() })

// A real member launched by `mrc team up` always has a TAMPER-PROOF host record with a secret (mrc.js
// writes it pre-launch, keyed by memberSessionId). R2/F3b bind requires classifySession 'normal' AND a
// secret on record, and R1 requires the register frame to carry the matching secret. So model production:
// write the record (deterministic secret from the id) AND send that secret in the register frame.
function registerMember(client, frame) {
  const secret = 'sec-' + String(frame.sessionId).slice(-12)
  saveSessionRecord(frame.sessionId, { repoPath: process.env.HOME, adversary: false, secret })
  client.send({ ...frame, type: 'register', secret })
}

// Redirect room files to a throwaway HOME so the test never touches the real ~/.local/share/mrc.
const TMP_HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-test-`)
process.env.HOME = TMP_HOME

function seededRng(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function client(port) {
  const frames = []
  const sock = net.connect(port, '127.0.0.1')
  let buf = ''
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) try { frames.push(JSON.parse(l)) } catch {} } })
  const send = (o) => sock.write(JSON.stringify(o) + '\n')
  const waitFor = async (pred, ms = 1500) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { const f = frames.find(pred); if (f) return f; await sleep(15) }
    throw new Error('timeout waiting for frame; got: ' + JSON.stringify(frames))
  }
  return { sock, frames, send, waitFor, ready: new Promise((res) => sock.on('connect', res)) }
}

function controlCall(port, frame) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify(frame) + '\n'))
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))) } catch (e) { reject(e) } c.end() } })
    c.on('error', reject)
    setTimeout(() => reject(new Error('control timeout')), 1500)
  })
}

test('daemon team rooms: define org, directed delivery, @user round-trip, brake/resume', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-dt-`)
  const port = await findFreePort(19000)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })

  const roster = {
    org: 'shop', repo: TMP_HOME,
    teams: [{ name: 'client', territory: 'client', members: [
      { role: 'architect', backend: 'claude', name: 'roland', lead: true },
      { role: 'engineer', backend: 'claude', name: 'ludivine' },
      { role: 'critic', backend: 'claude', name: 'pierre' },
    ] }],
  }
  const norm = parseRoster(roster, { rng: seededRng(1) })

  // 1) Define the org over the control socket.
  const def = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
  assert.equal(def.ok, true)
  assert.ok(def.rooms.includes(teamRoomId('shop', 'client')))

  // 2) Connect the three members and register them with their handles.
  const arch = client(port), engineer = client(port), critic = client(port)
  await Promise.all([arch.ready, engineer.ready, critic.ready])
  // Register with the REAL pinned memberSessionId (what `mrc team up` uses) — R2 binds only a pinned id / a
  // normal-classified session, not a bare-handle fallback on an arbitrary id.
  registerMember(arch, { sessionId: memberSessionId('shop', 'roland/claude'), memberHandle: 'roland/claude', repo: 'shop', label: 'roland' })
  registerMember(engineer, { sessionId: memberSessionId('shop', 'ludivine/claude'), memberHandle: 'ludivine/claude', repo: 'shop', label: 'ludivine' })
  registerMember(critic, { sessionId: memberSessionId('shop', 'pierre/claude'), memberHandle: 'pierre/claude', repo: 'shop', label: 'pierre' })
  // each gets a join notice listing its rooms
  const joined = await arch.waitFor((f) => f.type === 'notice' && /Joined as @roland/.test(f.text))
  assert.match(joined.text, new RegExp(teamRoomId('shop', 'client')))

  // 3) Architect directs the engineer; only the engineer receives it (directed-only floor control).
  arch.send({ type: 'say', id: 1, text: '@ludivine implement the login form' })
  const toEngineer = await engineer.waitFor((f) => f.type === 'deliver')
  assert.match(toEngineer.text, /implement the login form/)
  assert.match(toEngineer.text, /\[room client\]/)
  const ack = await arch.waitFor((f) => f.type === 'ack' && f.id === 1)
  assert.equal(ack.status, 'delivered')
  await sleep(60)
  assert.equal(critic.frames.filter((f) => f.type === 'deliver').length, 0, 'critic not addressed -> nothing delivered')

  // 4) @user inbox round-trip: engineer asks the human; control sees it; answer routes back as a directive.
  engineer.send({ type: 'say', id: 2, text: '@user toasts or inline errors?' })
  await engineer.waitFor((f) => f.type === 'ack' && f.id === 2)
  const teamState = await controlCall(controlPort, { action: 'team' })
  assert.equal(teamState.userInbox.length, 1)
  assert.equal(teamState.userInbox[0].from, 'ludivine/claude')
  const answered = await controlCall(controlPort, { action: 'answer', i: teamState.userInbox[0].id, text: 'inline', secret: controlSecret() })
  assert.equal(answered.ok, true)
  const directive = await engineer.waitFor((f) => f.type === 'directive')
  assert.match(directive.text, /\[Human reply to "[^"]*"\]: inline/)

  // SECURITY — the steer-gate + its twin (Pierre): `answer` (a trusted [Human reply]) and `steer` (a trusted
  // [Human directive]) inject the ONLY authoritative message classes over the any-uid TCP control port, so a raw
  // frame WITHOUT the 0600 control-secret must be REFUSED (capOk) — a cross-uid host process can't speak as the human.
  const forgedAnswer = await controlCall(controlPort, { action: 'answer', i: teamState.userInbox[0].id, text: 'forged reply' })   // NO secret
  assert.equal(forgedAnswer.ok, false, 'a no-secret answer is refused (capOk)')
  assert.match(forgedAnswer.error || '', /control-capability secret/)
  const aRoom = teamState.rooms.find((r) => r.roomId)?.roomId
  const forgedSteer = await controlCall(controlPort, { action: 'steer', roomId: aRoom, target: 'all', text: 'forged directive' })   // NO secret
  assert.equal(forgedSteer.ok, false, 'a no-secret steer is refused (capOk)')
  assert.match(forgedSteer.error || '', /control-capability secret/)

  // #44 graftresume — a CONTENT TRANSFER (copies a conversation into an agent's slice), so it's capOk-gated +
  // fenced by the orgDefs whitelist. (1) no secret → refused (never agent-initiated). (2) a non-member target →
  // refused LOUD (Pierre a: targetHandle validated against orgDefs, not client-trusted). (3) an unknown source ref
  // → refused (a ref must be a whitelist label, never a client slice path).
  const someHandle = norm.members[0].handle
  const forgedGraft = await controlCall(controlPort, { action: 'graftresume', org: norm.org, handle: someHandle, ref: 'you', uuid: '11111111-1111-1111-1111-111111111111' })   // NO secret
  assert.equal(forgedGraft.ok, false, 'a no-secret graftresume is refused (capOk) — a content transfer is human-mediated, never session-callable')
  assert.match(forgedGraft.error || '', /control-capability secret/)
  const nonMember = await controlCall(controlPort, { action: 'graftresume', org: norm.org, handle: 'nobody/claude', ref: 'you', uuid: '11111111-1111-1111-1111-111111111111', secret: controlSecret() })
  assert.equal(nonMember.ok, false, 'graftresume into a NON-member handle is refused (targetHandle validated against orgDefs, not client-trusted)')
  const badRef = await controlCall(controlPort, { action: 'graftresume', org: norm.org, handle: someHandle, ref: '@nobody/claude', uuid: '11111111-1111-1111-1111-111111111111', secret: controlSecret() })
  assert.equal(badRef.ok, false, 'graftresume from an unknown source ref is refused (a ref must be a whitelist label, never a client path)')

  // 4b) (d) triage over the WIRE: a non-★ (ludivine) @user QUESTION is triaged to its lead (roland) — the
  // lead gets an ESCALATION, resolves it via a `resolve` frame, and the answer reaches ludivine as PEER data.
  // The engine enforces auth against the AUTHENTICATED sessionId (proves the daemon passes the real caller):
  // the critic (a non-★) is refused; only the dispatched ★ resolves.
  engineer.send({ type: 'say', id: 20, text: '@user one call, or split intent/pay?', kind: 'question' })
  const esc = await arch.waitFor((f) => f.type === 'deliver' && /ESCALATION #/.test(f.text))
  const escId = Number(esc.text.match(/ESCALATION #(\d+)/)[1])
  critic.send({ type: 'resolve', id: 21, escId, answer: 'hijack' })
  const refusal = await critic.waitFor((f) => f.type === 'notice' && /not resolved/.test(f.text))
  assert.match(refusal.text, /only a ★|not dispatched/, 'a non-★ cannot resolve — the engine auth sees the real caller')
  arch.send({ type: 'resolve', id: 22, escId, answer: 'one call' })
  const leadAns = await engineer.waitFor((f) => f.type === 'deliver' && /one call/.test(f.text))
  assert.match(leadAns.text, /Peer \(/, "the lead's answer arrives as PEER data, never a [Human reply]")
  const st = await controlCall(controlPort, { action: 'team' })
  const resolved = st.userInbox.find((x) => x.id === escId)
  assert.equal(resolved.resolvedByLead, true, 'item marked resolved-by-lead')
  assert.equal(resolved.resolver, 'roland/claude', 'resolver from the trusted record')

  // 5) Brake holds; resume delivers in order.
  const roomId = teamRoomId('shop', 'client')
  await controlCall(controlPort, { action: 'brake', roomId, secret: controlSecret() })
  arch.send({ type: 'say', id: 3, text: '@ludivine step A' })
  arch.send({ type: 'say', id: 4, text: '@ludivine step B' })
  await sleep(80)
  const before = engineer.frames.filter((f) => f.type === 'deliver').length
  await controlCall(controlPort, { action: 'resume', roomId, secret: controlSecret() })
  await engineer.waitFor((f) => f.type === 'deliver' && /step B/.test(f.text))
  const stepFrames = engineer.frames.filter((f) => f.type === 'deliver' && /step [AB]/.test(f.text)).map((f) => f.text)
  assert.equal(stepFrames.length, 2)
  assert.match(stepFrames[0], /step A/); assert.match(stepFrames[1], /step B/)
  assert.ok(before <= engineer.frames.filter((f) => f.type === 'deliver').length)

  arch.sock.destroy(); engineer.sock.destroy(); critic.sock.destroy()
  daemon.stop()
})

test('daemon team: a stale launch record reconciles to running:false so the GUI can restart it', async () => {
  // The crash/restart trap: a team's containers die but team-launches.json keeps its record. The status
  // handler used to report every record as running:true, which kept orgRunning() true and HID the
  // ▶ Resume / 🚀 Launch button — the team could never be restarted from the dashboard.
  const home = fs.mkdtempSync(`${os.tmpdir()}/mrc-stale-`)
  process.env.HOME = home
  const port = await findFreePort(19100), controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })
  try {
    const norm = parseRoster({ org: 'shop', repo: home, teams: [{ name: 'client', members: [{ role: 'architect', backend: 'claude', lead: true }] }] }, {})
    await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
    const launchFile = `${home}/.local/share/mrc/team-launches.json`
    const running = async () => (await controlCall(controlPort, { action: 'team' })).launch.find((l) => l.org === 'shop')?.running

    // No tmux windows + a 10-minutes-old launch (crashed) → stale → running:false.
    fs.writeFileSync(launchFile, JSON.stringify({ shop: { session: 'dead', ttydUrl: 'http://x', at: Date.now() - 10 * 60_000 } }))
    assert.equal(await running(), false, 'a crashed (old, no-tmux) launch is NOT running → Resume button returns')

    // A just-written launch is still building its image (no tmux yet) → kept running:true during the grace.
    fs.writeFileSync(launchFile, JSON.stringify({ shop: { session: 'building', ttydUrl: 'http://x', at: Date.now() } }))
    assert.equal(await running(), true, 'a fresh launch stays running during the build window (no double-launch)')
  } finally {
    daemon.stop()
  }
})

test('daemon containment: two orgs sharing a handle bind to the RIGHT org via the sessionId index', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-dt-`)
  const port = await findFreePort(19100)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })

  // Two DISTINCT orgs with IDENTICAL handles (roland + pierre, both /claude) — the collision case.
  const mkOrg = (org) => parseRoster({ org, repo: TMP_HOME, teams: [{ name: 'core', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }] }, { rng: seededRng(1) })
  for (const org of ['alpha', 'beta']) {
    const n = mkOrg(org)
    const d = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: n.org, repo: n.repo, members: n.members, rooms: n.rooms } })
    assert.equal(d.ok, true)
  }

  // Register three members whose sessionIds are the REAL org-specific memberSessionId. Both pierres
  // share the bare handle; only the org-specific session id tells them apart.
  const aRoland = client(port), aPierre = client(port), bPierre = client(port)
  await Promise.all([aRoland.ready, aPierre.ready, bPierre.ready])
  registerMember(aRoland, { sessionId: memberSessionId('alpha', 'roland/claude'), memberHandle: 'roland/claude', repo: 'alpha' })
  registerMember(aPierre, { sessionId: memberSessionId('alpha', 'pierre/claude'), memberHandle: 'pierre/claude', repo: 'alpha' })
  registerMember(bPierre, { sessionId: memberSessionId('beta', 'pierre/claude'), memberHandle: 'pierre/claude', repo: 'beta' })
  // Each binds to its own org's room (proves the index disambiguated, not a bare-handle clobber).
  const aj = await aRoland.waitFor((f) => f.type === 'notice' && /Joined as @roland/.test(f.text))
  assert.match(aj.text, new RegExp(teamRoomId('alpha', 'core')))
  await aPierre.waitFor((f) => f.type === 'notice' && /Joined as @pierre/.test(f.text))
  await bPierre.waitFor((f) => f.type === 'notice' && /Joined as @pierre/.test(f.text))

  // alpha's roland addresses @pierre in alpha/core → ONLY alpha's pierre receives it; beta's pierre
  // (same handle, other org) gets nothing. No cross-org bleed through the shared daemon.
  aRoland.send({ type: 'say', id: 1, text: '@pierre review the alpha diff', roomId: teamRoomId('alpha', 'core') })
  const got = await aPierre.waitFor((f) => f.type === 'deliver')
  assert.match(got.text, /review the alpha diff/)
  await sleep(80)
  assert.equal(bPierre.frames.filter((f) => f.type === 'deliver').length, 0, 'beta pierre received nothing — containment holds')

  aRoland.sock.destroy(); aPierre.sock.destroy(); bPierre.sock.destroy()
  daemon.stop()
})

test('daemon #11: the ask_user `kind` survives say→route→inbox so questions keep their type', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-dt-`)
  const port = await findFreePort(19200)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })

  const norm = parseRoster({ org: 'shop', repo: TMP_HOME, teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'engineer', backend: 'claude', name: 'ludivine' },
  ] }] }, { rng: seededRng(1) })
  await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  const eng = client(port)
  await eng.ready
  registerMember(eng, { sessionId: memberSessionId('shop', 'ludivine/claude'), memberHandle: 'ludivine/claude', repo: 'shop' })
  await eng.waitFor((f) => f.type === 'notice' && /Joined/.test(f.text))

  // ask_user → say frame WITH kind:'question'; plain @user → say frame WITHOUT kind.
  eng.send({ type: 'say', id: 1, text: '@user toasts or inline?', kind: 'question' })
  await eng.waitFor((f) => f.type === 'ack' && f.id === 1)
  eng.send({ type: 'say', id: 2, text: '@user heads up, deploy is done' })
  await eng.waitFor((f) => f.type === 'ack' && f.id === 2)

  const st = await controlCall(controlPort, { action: 'team' })
  const inbox = st.userInbox
  assert.equal(inbox.length, 2)
  assert.equal(inbox.find((x) => /toasts/.test(x.text)).type, 'question', 'kind survived all three hops')
  assert.equal(inbox.find((x) => /deploy/.test(x.text)).type, 'notification', 'plain @user defaulted to notification')

  // dismiss the notification → cleared, no reply routed; answer the question → [Human reply] delivered.
  // Address items by their STABLE id (not array index) — the wire `i` carries the id now.
  await controlCall(controlPort, { action: 'dismiss', i: inbox.find((x) => /deploy/.test(x.text)).id, secret: controlSecret() })
  await controlCall(controlPort, { action: 'answer', i: inbox.find((x) => /toasts/.test(x.text)).id, text: 'inline', secret: controlSecret() })
  const reply = await eng.waitFor((f) => f.type === 'directive' && /Human reply/.test(f.text))
  assert.match(reply.text, /inline/)
  const st2 = await controlCall(controlPort, { action: 'team' })
  assert.equal(st2.userInbox.find((x) => /deploy/.test(x.text)).dismissed, true)
  assert.equal(st2.userInbox.find((x) => /toasts/.test(x.text)).answered, true)

  eng.sock.destroy()
  daemon.stop()
})

test('daemon #16: the @user inbox survives a daemon restart (no loss, no resurrection, fresh ids)', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-dt-`)
  const boot = async () => {
    const port = await findFreePort(19250)
    const controlPort = await findFreePort(port + 1)
    return { port, controlPort, daemon: startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) }) }
  }
  let { port, controlPort, daemon } = await boot()
  const norm = parseRoster({ org: 'shop', repo: process.env.HOME, teams: [{ name: 'core', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
  ] }] }, { rng: seededRng(1) })
  await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  const lead = client(port); await lead.ready
  registerMember(lead, { sessionId: memberSessionId('shop', 'roland/claude'), memberHandle: 'roland/claude', repo: 'shop' })
  await lead.waitFor((f) => f.type === 'notice' && /Joined/.test(f.text))
  lead.send({ type: 'say', id: 1, text: '@user q1?', kind: 'question', room: 'leads' })
  lead.send({ type: 'say', id: 2, text: '@user q2?', kind: 'question', room: 'leads' })
  lead.send({ type: 'say', id: 3, text: '@user fyi note', room: 'leads' })          // notification
  await sleep(250)
  let inbox = (await controlCall(controlPort, { action: 'team' })).userInbox
  assert.equal(inbox.length, 3)
  const byText = (s) => inbox.find((x) => x.text.includes(s))
  await controlCall(controlPort, { action: 'answer', i: byText('q1').id, text: 'inline', secret: controlSecret() })   // resolve one
  await controlCall(controlPort, { action: 'dismiss', i: byText('fyi').id, secret: controlSecret() })                  // dismiss one
  await sleep(120)
  const before = (await controlCall(controlPort, { action: 'team' })).userInbox
  const maxId = Math.max(...before.map((x) => x.id))
  lead.sock.destroy(); daemon.stop(); await sleep(150)

  // RESTART on the same HOME.
  ;({ port, controlPort, daemon } = await boot())
  await sleep(150)
  const after = (await controlCall(controlPort, { action: 'team' })).userInbox
  assert.equal(after.length, 3, 'all 3 items survive the restart — no loss')
  const a = (s) => after.find((x) => x.text.includes(s))
  assert.equal(a('q1').answered, true, 'answered item stays answered (no resurrection)')
  assert.equal(a('q1').answer, 'inline')
  assert.equal(a('fyi').dismissed, true, 'dismissed item stays dismissed')
  assert.equal(a('q2').answered, false); assert.equal(a('q2').dismissed, false)   // still open
  assert.equal(a('q2').type, 'question'); assert.equal(a('fyi').type, 'notification')   // type survives
  assert.equal(a('q1').org, 'shop')   // org survives → per-tab scoping holds
  assert.deepEqual(after.map((x) => x.id).sort(), before.map((x) => x.id).sort(), 'stable ids survive')

  // A NEW question post-restart gets a FRESH id past the max restored id (no collision → TG-reply mapping safe).
  const lead2 = client(port); await lead2.ready
  registerMember(lead2, { sessionId: memberSessionId('shop', 'roland/claude'), memberHandle: 'roland/claude', repo: 'shop' })
  await lead2.waitFor((f) => f.type === 'notice' && /Joined/.test(f.text))
  lead2.send({ type: 'say', id: 9, text: '@user q4 after restart?', kind: 'question', room: 'leads' })
  await sleep(200)
  const final = (await controlCall(controlPort, { action: 'team' })).userInbox
  const fresh = final.find((x) => x.text.includes('q4'))
  assert.ok(fresh && fresh.id > maxId, `new item id ${fresh?.id} is past the restored max ${maxId}`)

  lead2.sock.destroy(); daemon.stop()
})

test('#3/AUDIT: a member cannot bind under a DIFFERENT handle than its pinned session id maps to', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-bindforge-`)
  const port = await findFreePort(19500)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })
  const roster = { org: 'shop', repo: process.env.HOME, teams: [{ name: 'client', territory: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }] }
  const norm = parseRoster(roster, { rng: seededRng(1) })
  await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  // roland's REAL verified session (its own pinned id + secret, classifySession 'normal') claims pierre's handle
  // → a forge → REFUSED, because the bind handle is derived from the pinned id, not the wire f.memberHandle.
  const forge = client(port); await forge.ready
  registerMember(forge, { sessionId: memberSessionId('shop', 'roland/claude'), memberHandle: 'pierre/claude', repo: 'shop', label: 'roland' })
  const refused = await forge.waitFor((f) => f.type === 'notice' && /pinned to @roland\/claude, not @pierre\/claude/.test(f.text))
  assert.ok(refused, 'a verified member cannot bind AS a different member — delivery-hijack + from-forge closed (R2 gap)')

  // sanity: the same session binding as its OWN pinned handle still succeeds (no false-refusal of legit members).
  const legit = client(port); await legit.ready
  registerMember(legit, { sessionId: memberSessionId('shop', 'pierre/claude'), memberHandle: 'pierre/claude', repo: 'shop', label: 'pierre' })
  await legit.waitFor((f) => f.type === 'notice' && /Joined as @pierre/.test(f.text))

  daemon?.stop?.()
  for (const c of [forge, legit]) try { c.sock.destroy() } catch {}
})

test('#3/AUDIT: a verified-normal NON-member cannot bind a member slot via a wire handle (cross-org impersonation; legacy fallback amputated)', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-crossorg-`)
  const port = await findFreePort(19550)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })
  const roster = { org: 'shop', repo: process.env.HOME, teams: [{ name: 'client', territory: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }] }
  const norm = parseRoster(roster, { rng: seededRng(1) })
  await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  // The ATTACKER is a verified-normal NON-member: a PLAIN conversation UUID (never sha1(org\0handle)), with its
  // OWN secret on record (every mrc session gets one → verifiedNormal true → R1 passes on its own secret). It crafts
  // a register frame claiming a real member's handle. PRE-FIX this rode the idx===undefined legacy fallback →
  // orgsWithHandle('pierre/claude') → bindSession CLOBBERED pierre's slot (delivery hijack + attribution forge). The
  // amputation refuses it: no pinned identity, so the wire handle is never trusted for a non-pinned caller.
  const attacker = client(port); await attacker.ready
  const attackerId = '11111111-2222-3333-4444-555555555555'   // a plain UUID; NOT a pinned memberSessionId
  registerMember(attacker, { sessionId: attackerId, memberHandle: 'pierre/claude', repo: 'evil', label: 'evil' })
  const refused = await attacker.waitFor((f) => f.type === 'notice' && /no pinned member identity/.test(f.text))
  assert.ok(refused, 'a verified-normal non-member is refused a member bind — the wire-handle legacy fallback is deleted')

  // And the REAL pierre (its pinned id + secret) still binds — the amputation does not false-refuse legit members.
  const legit = client(port); await legit.ready
  registerMember(legit, { sessionId: memberSessionId('shop', 'pierre/claude'), memberHandle: 'pierre/claude', repo: 'shop', label: 'pierre' })
  await legit.waitFor((f) => f.type === 'notice' && /Joined as @pierre/.test(f.text))

  daemon?.stop?.()
  for (const c of [attacker, legit]) try { c.sock.destroy() } catch {}
})

test('#38: a register presenting a reserved memberSessionId WITHOUT a verified-member record is refused (slot-squat closed)', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-slotsquat-`)
  const port = await findFreePort(19600)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })
  const roster = { org: 'shop', repo: process.env.HOME, teams: [{ name: 'client', territory: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }] }
  const norm = parseRoster(roster, { rng: seededRng(1) })
  await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  // The attacker computes pierre's PUBLIC derived id (sha1(org\0handle)) and registers with it BEFORE the real pierre
  // launches — no record on disk, so R1 has no secret to check. #38 refuses it so it can't squat the future slot.
  const squatter = client(port); await squatter.ready
  squatter.send({ type: 'register', sessionId: memberSessionId('shop', 'pierre/claude'), memberHandle: 'pierre/claude', repo: 'evil', label: 'evil' })   // no secret, no record written
  const rej = await squatter.waitFor((f) => f.type === 'notice' && /reserved member identity/.test(f.text))
  assert.ok(rej, 'a reserved memberSessionId without a verified-member record is refused at register — the sessions-Map slot-squat is closed')

  // The REAL pierre (record + secret written pre-launch) still registers and binds fine — no false-refusal.
  const legit = client(port); await legit.ready
  registerMember(legit, { sessionId: memberSessionId('shop', 'pierre/claude'), memberHandle: 'pierre/claude', repo: 'shop', label: 'pierre' })
  await legit.waitFor((f) => f.type === 'notice' && /Joined as @pierre/.test(f.text))

  daemon?.stop?.()
  for (const c of [squatter, legit]) try { c.sock.destroy() } catch {}
})

// #59 — the org-lifecycle record reap, and its landmine (the invert of #56 bug C): reap ONLY on def-membership
// REMOVAL (removemember / removeorg), NEVER on liveness (a suspend/stop leaves the member in the def → its auth
// anchor MUST survive so it re-binds on resume via record.secret). The whole correctness of #59 is this triangle:
// suspend KEEPS · remove-one REAPS-one (others kept) · remove-org REAPS-all.
test('#59 record reap: stopteam KEEPS, removemember reaps one, removeorg reaps all (never on liveness)', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-reap-`)
  const port = await findFreePort(19700)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })

  const roster = { org: 'reapco', repo: process.env.HOME, teams: [{ name: 'client', territory: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'engineer', backend: 'claude', name: 'ludivine' },
  ] }] }
  const norm = parseRoster(roster, { rng: seededRng(1) })
  const rolandId = memberSessionId('reapco', 'roland/claude')
  const ludiId = memberSessionId('reapco', 'ludivine/claude')

  const def = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
  assert.equal(def.ok, true)

  // Both members carry a tamper-proof host record with a secret, exactly as `mrc team up` writes pre-launch.
  saveSessionRecord(rolandId, { repoPath: process.env.HOME, member: true, secret: 'sec-roland' })
  saveSessionRecord(ludiId, { repoPath: process.env.HOME, member: true, secret: 'sec-ludi' })
  const present = (id) => loadSessionRecord(id).uuid === id
  assert.ok(present(rolandId) && present(ludiId), 'both records written')

  // (1) SUSPEND — the org + both members stay in the def, containers merely stop → records MUST survive (the
  //     landmine: reaping here re-opens 9e1512f in reverse — a suspended member could never re-register on resume).
  const stopped = await controlCall(controlPort, { action: 'stopteam', org: 'reapco', secret: controlSecret() })
  assert.equal(stopped.ok, true)
  assert.ok(present(rolandId) && present(ludiId), 'suspend KEEPS every member record (never reap on liveness)')

  // (2) removemember — ludivine LEAVES the def → her record is reaped; roland (still defined) keeps his.
  const rm = await controlCall(controlPort, { action: 'removemember', org: 'reapco', handle: 'ludivine/claude', secret: controlSecret() })
  assert.equal(rm.ok, true, 'removemember succeeded (teamMod loaded)')
  assert.ok(!present(ludiId), 'the removed member’s record is reaped')
  assert.ok(present(rolandId), 'a still-defined member keeps its record (no collateral reap)')

  // (3) removeorg — the whole org is deleted → every remaining member record reaped.
  const del = await controlCall(controlPort, { action: 'removeorg', org: 'reapco', secret: controlSecret() })
  assert.equal(del.ok, true)
  assert.ok(!present(rolandId), 'removeorg reaps all remaining member records')

  daemon?.stop?.()
})

// #59b/#70 — the authoritative-redefine reap-diff. A builder team-define carries the human's COMPLETE edited roster,
// so a member dropped there is an intentional removal → reap. A relaunch/boot rebuild does NOT set authoritative, so a
// member transiently absent from it must be KEPT (the invert-limbo landmine again). Triangle: authoritative-drop REAPS ·
// non-authoritative-drop KEEPS · still-present members kept.
test('#59b/#70 authoritative redefine reaps a dropped member; a non-authoritative (relaunch) redefine KEEPS', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-reapdiff-`)
  const HOME = process.env.HOME
  const port = await findFreePort(19800)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 100, workerInvoke: async () => ({ text: '' }) })

  const parse = (names) => parseRoster({ org: 'redefco', repo: HOME, teams: [{ name: 'client', territory: 'client',
    members: names.map((n, i) => ({ role: i === 0 ? 'architect' : 'engineer', backend: 'claude', name: n, ...(i === 0 ? { lead: true } : {}) })) }] }, { rng: seededRng(1) })
  const idOf = (n) => memberSessionId('redefco', `${n}/claude`)
  const present = (id) => loadSessionRecord(id).uuid === id
  const define = (norm, extra) => controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: false, secret: controlSecret(), ...extra, def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

  // A dropped member's ORPHANED caged-Pierre consult record is reaped too (Pierre t209) — same buildCagedConsult handle.
  const pierreIdOf = (n) => memberSessionId('redefco', `pierre.${n}-claude/claude`)   // pierre.<handle-with-/→->/claude

  // Define the full 3-member org (authoritative), then give each a tamper-proof host record + a caged-Pierre consult record.
  await define(parse(['roland', 'ludivine', 'gaston']), { activate: true, authoritative: true })
  for (const n of ['roland', 'ludivine', 'gaston']) {
    saveSessionRecord(idOf(n), { repoPath: HOME, member: true, secret: 'sec-' + n })
    saveSessionRecord(pierreIdOf(n), { repoPath: HOME, adversary: true, summonedBy: idOf(n), secret: 'psec-' + n })   // each summoned a Pierre
  }
  assert.ok(['roland', 'ludivine', 'gaston'].every((n) => present(idOf(n)) && present(pierreIdOf(n))), 'all member + Pierre records written')

  // (A) AUTHORITATIVE redefine dropping ludivine → HER record AND her orphaned Pierre's record reaped; the others kept.
  const a = await define(parse(['roland', 'gaston']), { authoritative: true })
  assert.equal(a.ok, true)
  assert.ok(!present(idOf('ludivine')), 'an authoritative drop reaps the removed member’s record')
  assert.ok(!present(pierreIdOf('ludivine')), 'and its orphaned caged-Pierre consult record (the sweep completes)')
  assert.ok(present(idOf('roland')) && present(idOf('gaston')), 'still-present members keep their records')
  assert.ok(present(pierreIdOf('gaston')), 'a still-present member keeps its Pierre record')

  // (B) NON-authoritative redefine dropping gaston (models a relaunch/boot rebuild — the flag ABSENT) → BOTH kept.
  const b = await define(parse(['roland']))
  assert.equal(b.ok, true)
  assert.ok(present(idOf('gaston')) && present(pierreIdOf('gaston')), 'a non-authoritative redefine NEVER reaps (invert-limbo landmine) — gaston + its Pierre kept')

  daemon?.stop?.()
})

// #t12 — the cross-project Pierre-lock collision. The caged-Pierre launch-lock (resumingConsults) coalesces
// concurrent summon/resume/cast so two launches don't race one deterministic sessionId. It was keyed on the bare
// pierreHandle — but the handle is `pierre.<summoner>/claude`, and two DIFFERENT projects whose summoners share the
// default `claude/claude` handle mint the IDENTICAL handle, so project A's in-flight launch FALSE-BLOCKED project B's
// Pierre ("already in flight"). A human staring at that dead-looking Pierre dismiss/resumes — which reaps the
// container — so the coarse key manufactured the drop loop. Fix: key on the org-scoped pierreSessionId at all sites.
test('#t12: two projects sharing a summoner handle → identical Pierre handle but DISTINCT org-scoped sessionIds', () => {
  const shared = 'pierre.claude-claude/claude'   // both default projects: summoner claude/claude → this handle
  assert.equal(memberSessionId('projA', shared), memberSessionId('projA', shared), 'sessionId is deterministic')
  assert.notEqual(memberSessionId('projA', shared), memberSessionId('projB', shared),
    'the fix premise: the sessionId is org-unique, so a lock keyed on it cannot false-block across projects — the bare handle (identical here) did')
})

test('#t12: the resumingConsults launch-lock keys on *SessionId at every site, never a bare handle (regression guard)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/proxies/room-daemon.js', import.meta.url), 'utf8')
  const ops = [...src.matchAll(/resumingConsults\.(?:add|has|delete)\(([^)]*)\)/g)].map((m) => m[1].trim())
  assert.ok(ops.length >= 3, `expected the lock at ≥3 launch sites, found ${ops.length}`)
  for (const arg of ops) assert.match(arg, /pierreSessionId$/,
    `resumingConsults keyed on "${arg}" — must be the org-scoped *pierreSessionId, never a bare handle, or the cross-project false-block returns`)
})

// ─── t27 CONTAINER-RESTART RESUME — the register-seam regression (reproduce-first) ────────────────────────────
// The ordering hole (bindSession's pendingDeliveries live-write BEFORE flushOutbox) does NOT exist in the pure
// outbox/dedup modules — it only appears at the real daemon register handler. So these MUST be integration tests
// on the live daemon, or they'd pass with-or-without the fix (Pierre: unit necessary, not sufficient).

// A relay client that MIRRORS the shipping container receive path: runs createInboundDedup, cumulative-rcpts,
// collects surfaced text, and reports (epoch, highest) so a re-register carries the t27 resume token. Passing a
// FRESH createInboundDedup models a container PROCESS restart (dedup state gone); reusing one models a flap.
function dedupClient(port, dedup) {
  const surfaced = []
  const raw = []
  const sock = net.connect(port, '127.0.0.1')
  _testSocks.add(sock); try { sock.unref() } catch {}
  let buf = ''
  sock.on('data', (d) => {
    buf += d; let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue
      let f; try { f = JSON.parse(l) } catch { continue }
      raw.push(f)
      const r = dedup.observe(f)
      if (r.reliable) { try { sock.write(JSON.stringify({ type: 'rcpt', epoch: dedup.epoch(), seq: r.ackSeq }) + '\n') } catch {} ; for (const fr of r.surface) if (!fr.discard && fr.text) surfaced.push(fr.text) }
    }
  })
  const send = (o) => sock.write(JSON.stringify(o) + '\n')
  const registerAs = (id, handle) => {
    const secret = 'sec-' + String(id).slice(-12)
    saveSessionRecord(id, { repoPath: process.env.HOME, adversary: false, secret })
    send({ type: 'register', sessionId: id, memberHandle: handle, repo: 'shop', label: handle, secret, ackEpoch: dedup.epoch() || undefined, ackSeq: dedup.highest() })
  }
  return { sock, surfaced, raw, dedup, send, registerAs, ready: new Promise((res) => sock.on('connect', res)) }
}

async function bootShopWithRoland(base) {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-t27-`)
  const port = await findFreePort(base)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 1000, workerInvoke: async () => ({ text: '' }) })
  const roster = { org: 'shop', repo: process.env.HOME, teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }] }
  const norm = parseRoster(roster, { rng: seededRng(1) })
  const def = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
  assert.equal(def.ok, true)
  const roland = client(port); await roland.ready
  _testSocks.add(roland.sock); try { roland.sock.unref() } catch {}
  registerMember(roland, { sessionId: memberSessionId('shop', 'roland/claude'), memberHandle: 'roland/claude', repo: 'shop', label: 'roland' })
  await roland.waitFor((f) => f.type === 'notice' && /Joined as @roland/.test(f.text))
  return { port, controlPort, daemon, roland, pierreId: memberSessionId('shop', 'pierre/claude') }
}

test('t27 (hole 3): a FRESH process (dedup high-water 0) resuming vs a mid-stream daemon (seq»0) surfaces the pending content', async () => {
  const { port, daemon, roland, pierreId } = await bootShopWithRoland(19600)

  // M1 = the first pierre connection (fresh D1). seq STARTS at 1 here so M1 works; it acks the burst → the
  // daemon's per-session seq climbs well past 0.
  const m1 = dedupClient(port, createInboundDedup()); await m1.ready
  m1.registerAs(pierreId, 'pierre/claude'); m1.send({ type: 'ping' }); await sleep(90)
  for (let k = 1; k <= 12; k++) { roland.send({ type: 'say', id: 100 + k, text: `@pierre msg-${k}` }); await sleep(18) }
  await sleep(150)
  assert.ok(m1.surfaced.length >= 10, `M1 received the burst (got ${m1.surfaced.length}) — daemon seq is now ~12`)

  // M1's PROCESS dies (socket + dedup object gone) → daemon unbinds pierre.
  m1.sock.destroy(); await sleep(150)
  // Two more while offline → pendingDeliveries → they'll be assigned HIGH seqs (13,14) on rebind.
  roland.send({ type: 'say', id: 200, text: '@pierre FINAL-ALPHA' })
  roland.send({ type: 'say', id: 201, text: '@pierre FINAL-BETA' })
  await sleep(120)

  // M2 = a FRESH dedup (D2) — the container PROCESS restart. Its register carries ackEpoch=null.
  const m2 = dedupClient(port, createInboundDedup()); await m2.ready
  m2.registerAs(pierreId, 'pierre/claude'); await sleep(200)

  // RED without the fix: D2 (highest 0) holds seq 13,14 at the unfillable gap [1..12] → nothing surfaces.
  // GREEN with resume/enqueue-only: the pending set is resequenced to 1..K → surfaced from the first frame.
  assert.ok(m2.surfaced.some((t) => /FINAL-ALPHA/.test(t)), `fresh process must surface FINAL-ALPHA — got ${JSON.stringify(m2.surfaced)}`)
  assert.ok(m2.surfaced.some((t) => /FINAL-BETA/.test(t)), `fresh process must surface FINAL-BETA — got ${JSON.stringify(m2.surfaced)}`)

  roland.sock.destroy(); m2.sock.destroy(); daemon.stop()
})

test('t27 (hole 3, floor>0): a fresh resume with an OVERFLOWED outbox surfaces the kept content — guards the enqueue-only (a stale-floor live-write must not jump the fresh receiver past the resequenced set)', async () => {
  process.env.MRC_ROOM_OUTBOX_CAP = '4'   // small cap so the pendingDeliveries flush OVERFLOWS → floor>0
  let ctx
  try { ctx = await bootShopWithRoland(19700) } finally { delete process.env.MRC_ROOM_OUTBOX_CAP }
  const { port, daemon, roland, pierreId } = ctx

  const m1 = dedupClient(port, createInboundDedup()); await m1.ready
  m1.registerAs(pierreId, 'pierre/claude'); m1.send({ type: 'ping' }); await sleep(90)
  for (let k = 1; k <= 3; k++) { roland.send({ type: 'say', id: 500 + k, text: `@pierre warm-${k}` }); await sleep(18) }
  await sleep(120)
  m1.sock.destroy(); await sleep(150)

  // 6 while offline → pendingDeliveries. On M2 rebind they flush into the (cap-4) outbox at once → OVERFLOW →
  // the oldest 2 are evicted (floor>0), the newest 4 kept. WITHOUT enqueue-only, bindSession live-writes all 6
  // at their high seqs carrying the STALE floor → the fresh receiver's high-water jumps past the resequenced
  // 1..K → the kept content is dropped. WITH enqueue-only, flushOutbox drains the resequenced set alone.
  for (let k = 1; k <= 6; k++) roland.send({ type: 'say', id: 600 + k, text: `@pierre OVER-${k}` })
  await sleep(150)

  const m2 = dedupClient(port, createInboundDedup()); await m2.ready
  m2.registerAs(pierreId, 'pierre/claude'); await sleep(220)

  assert.ok(m2.surfaced.some((t) => /OVER-6/.test(t)), `newest kept message must surface after an overflow resume — got ${JSON.stringify(m2.surfaced)}`)
  assert.ok(m2.surfaced.some((t) => /OVER-5/.test(t)), `OVER-5 (kept) must surface — got ${JSON.stringify(m2.surfaced)}`)
  assert.ok(m2.surfaced.some((t) => /lost/.test(t)), 'and a loud loss-warning for the evicted ones')

  roland.sock.destroy(); m2.sock.destroy(); daemon.stop()
})

test('t27 (hole 1): a throw inside the resume block clears resumeFresh (the finally) — a later LIVE send still WRITES, not enqueue-only-forever', async () => {
  const { port, daemon, roland, pierreId } = await bootShopWithRoland(19650)

  // Give pierre an outbox + go offline (so a fresh resume-register actually enters the resume path).
  const m1 = dedupClient(port, createInboundDedup()); await m1.ready
  m1.registerAs(pierreId, 'pierre/claude'); m1.send({ type: 'ping' }); await sleep(90)
  for (let k = 1; k <= 6; k++) { roland.send({ type: 'say', id: 300 + k, text: `@pierre warm-${k}` }); await sleep(18) }
  await sleep(120)
  m1.sock.destroy(); await sleep(150)
  roland.send({ type: 'say', id: 400, text: '@pierre PENDING-WHILE-OFFLINE' }); await sleep(80)

  // FORCE a throw inside the resume block on M2's fresh register (fault-injection seam).
  process.env.MRC_TEST_THROW_IN_RESUME = '1'
  const m2 = dedupClient(port, createInboundDedup()); await m2.ready
  m2.registerAs(pierreId, 'pierre/claude'); await sleep(200)
  delete process.env.MRC_TEST_THROW_IN_RESUME   // the throw only affects M2's register; clear it now

  // The daemon must have SURVIVED the throw (not crashed) and CLEARED the flag in the finally. Prove it by the
  // WRITE, not the surface: a subsequent LIVE @pierre must reach M2's SOCKET (m2.raw). If resumeFresh leaked
  // (clear NOT in the finally), the send is enqueue-only forever and never hits the wire → not in raw. (Whether
  // the fresh dedup SURFACES it is bug-1's concern — the resume was skipped by the throw — so we assert the wire
  // write, which is exactly what the flag governs.)
  roland.send({ type: 'say', id: 401, text: '@pierre LIVE-AFTER-THROW' })
  const t0 = Date.now(); let got = false
  while (Date.now() - t0 < 2500) { if (m2.raw.some((f) => /LIVE-AFTER-THROW/.test(f.text || ''))) { got = true; break } await sleep(40) }
  assert.ok(got, `after a throw in the resume block, a live send must still WRITE to the socket (flag cleared, not enqueue-only) — got raw ${JSON.stringify(m2.raw.map((f) => f.type))}`)

  roland.sock.destroy(); m1.sock.destroy(); m2.sock.destroy(); daemon.stop()
})
