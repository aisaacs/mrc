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
  arch.send({ type: 'register', sessionId: 's-arch', memberHandle: 'roland/claude', repo: 'shop', label: 'roland' })
  engineer.send({ type: 'register', sessionId: 's-engineer', memberHandle: 'ludivine/claude', repo: 'shop', label: 'ludivine' })
  critic.send({ type: 'register', sessionId: 's-critic', memberHandle: 'pierre/claude', repo: 'shop', label: 'pierre' })
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
  const answered = await controlCall(controlPort, { action: 'answer', i: 0, text: 'inline' })
  assert.equal(answered.ok, true)
  const directive = await engineer.waitFor((f) => f.type === 'directive')
  assert.match(directive.text, /\[Human reply\]: inline/)

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
