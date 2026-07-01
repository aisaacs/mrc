// Socket-level integration test for team rooms on the real daemon: boots startRoomDaemon, defines an
// org over the control socket, connects member relay sockets, and exercises directed @delivery, the
// @user inbox round-trip, and brake/resume — over the actual newline-JSON wire protocol.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { startRoomDaemon } from '../src/proxies/room-daemon.js'
import { findFreePort } from '../src/ports.js'
import { parseRoster, teamRoomId } from '../src/teams/roster.js'
import { memberSessionId } from '../src/teams/session-id.js'
import { saveSessionRecord } from '../src/session-record.js'

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
  const def = await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
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
  const answered = await controlCall(controlPort, { action: 'answer', i: teamState.userInbox[0].id, text: 'inline' })
  assert.equal(answered.ok, true)
  const directive = await engineer.waitFor((f) => f.type === 'directive')
  assert.match(directive.text, /\[Human reply to "[^"]*"\]: inline/)

  // 5) Brake holds; resume delivers in order.
  const roomId = teamRoomId('shop', 'client')
  await controlCall(controlPort, { action: 'brake', roomId })
  arch.send({ type: 'say', id: 3, text: '@ludivine step A' })
  arch.send({ type: 'say', id: 4, text: '@ludivine step B' })
  await sleep(80)
  const before = engineer.frames.filter((f) => f.type === 'deliver').length
  await controlCall(controlPort, { action: 'resume', roomId })
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
    await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
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
    const d = await controlCall(controlPort, { action: 'defineOrg', def: { org: n.org, repo: n.repo, members: n.members, rooms: n.rooms } })
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
  await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

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
  await controlCall(controlPort, { action: 'dismiss', i: inbox.find((x) => /deploy/.test(x.text)).id })
  await controlCall(controlPort, { action: 'answer', i: inbox.find((x) => /toasts/.test(x.text)).id, text: 'inline' })
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
  await controlCall(controlPort, { action: 'defineOrg', def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })

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
  await controlCall(controlPort, { action: 'answer', i: byText('q1').id, text: 'inline' })   // resolve one
  await controlCall(controlPort, { action: 'dismiss', i: byText('fyi').id })                  // dismiss one
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
