// REAL-CONTAINER integration test — the container-receive last mile that the mirror-client integration tests
// (daemon-teams.test.mjs) structurally cannot prove. Here the ACTUAL container/mrc-channel-server.js runs as a
// subprocess (MCP SDK stubbed via the load-gate hook; the capture stub prints one `SURFACED\t<content>` line per
// pushIn), connects to a real in-process daemon over a real socket, and its REAL onFrame → createInboundDedup →
// pushIn → renderFrame path is exercised end to end. Killing + respawning the subprocess models a container
// PROCESS restart (fresh dedup) — the exact seam BOTH t27 redelivery regressions lived in (the fresh-gap and the
// always-false roomStillLive discard), neither of which any host unit/mirror test could see.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { startRoomDaemon as _startRoomDaemon } from '../src/proxies/room-daemon.js'
import { findFreePort } from '../src/ports.js'
import { parseRoster } from '../src/teams/roster.js'
import { memberSessionId } from '../src/teams/session-id.js'
import { saveSessionRecord } from '../src/session-record.js'
import { controlSecret } from '../src/rooms.js'

const here = dirname(fileURLToPath(import.meta.url))
const registrar = join(here, 'fixtures', 'register-sdk-stub.mjs')
const bootHarness = join(here, 'fixtures', 'boot-channel-server.mjs')

const _daemons = new Set(), _procs = new Set(), _socks = new Set()
function startRoomDaemon(o) { const d = _startRoomDaemon(o); if (d) _daemons.add(d); return d }
afterEach(() => {
  for (const p of _procs) { try { p.kill('SIGKILL') } catch {} } _procs.clear()
  for (const s of _socks) { try { s.destroy() } catch {} } _socks.clear()
  for (const d of _daemons) { try { d.stop?.() } catch {} } _daemons.clear()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const seededRng = (seed = 1) => { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }

function client(port) {
  const frames = []
  const sock = net.connect(port, '127.0.0.1'); _socks.add(sock); try { sock.unref() } catch {}
  let buf = ''
  sock.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) try { frames.push(JSON.parse(l)) } catch {} } })
  sock.on('error', () => {})
  return { sock, frames, send: (o) => sock.write(JSON.stringify(o) + '\n'), ready: new Promise((res) => sock.on('connect', res)) }
}
function controlCall(port, frame) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify(frame) + '\n')); _socks.add(c)
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))) } catch (e) { reject(e) } c.end() } })
    c.on('error', reject); setTimeout(() => reject(new Error('control timeout')), 2000)
  })
}
const registerAsMember = (c, sessionId, handle) => {
  const secret = 'sec-' + String(sessionId).slice(-12)
  saveSessionRecord(sessionId, { repoPath: process.env.HOME, adversary: false, secret })
  c.send({ type: 'register', sessionId, memberHandle: handle, repo: 'shop', label: handle, secret })
}

// Spawn the REAL channel server as a member's container process; collect its SURFACED lines (what it pushIn'd).
function bootContainer(port, sessionId, handle) {
  const surfaced = [], stderr = []
  const secret = 'sec-' + String(sessionId).slice(-12)
  saveSessionRecord(sessionId, { repoPath: process.env.HOME, adversary: false, secret })
  const env = { ...process.env, MRC_ROOM_PORT: String(port), MRC_ROOM_HOST: '127.0.0.1', MRC_SESSION_ID: sessionId, MRC_MEMBER_HANDLE: handle, MRC_REPO_NAME: 'shop', MRC_ROOM_SECRET: secret, MRC_ROOM_LOG: join(os.tmpdir(), `mrc-ch-${sessionId.slice(0, 8)}-${Date.now()}.log`), MRC_STATUS_FILE: join(os.tmpdir(), `mrc-st-${sessionId.slice(0, 8)}.json`) }
  const proc = spawn(process.execPath, ['--import', registrar, bootHarness], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  _procs.add(proc)
  let buf = ''
  proc.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); const m = l.match(/^SURFACED\t(.*)$/); if (m) { try { surfaced.push(JSON.parse(m[1])) } catch { surfaced.push(m[1]) } } } })
  proc.stderr.on('data', (d) => stderr.push(d.toString()))
  return { proc, surfaced, stderr }
}
const waitSurface = async (surfaced, sub, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (surfaced.some((t) => String(t).includes(sub))) return true; await sleep(60) } return false }

test('REAL container: the shipping mrc-channel-server surfaces a LIVE msg AND a buffered-while-down msg on process-restart resume, over a real socket', async () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-live-`)
  const port = await findFreePort(19800)
  const controlPort = await findFreePort(port + 1)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9, turnCap: 1000, workerInvoke: async () => ({ text: '' }) })

  const roster = { org: 'shop', repo: process.env.HOME, teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'critic', backend: 'claude', name: 'pierre' },
  ] }] }
  const norm = parseRoster(roster, { rng: seededRng(1) })
  const def = await controlCall(controlPort, { action: 'defineOrg', trusted: true, activate: true, secret: controlSecret(), def: { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms } })
  assert.equal(def.ok, true)

  // roland = the sender (a plain relay client bound as the lead).
  const roland = client(port); await roland.ready
  registerAsMember(roland, memberSessionId('shop', 'roland/claude'), 'roland/claude')
  await sleep(150)

  const pierreId = memberSessionId('shop', 'pierre/claude')

  // 1) Boot the REAL pierre container (subprocess). Confirm it connects + surfaces a LIVE @pierre message.
  let p = bootContainer(port, pierreId, 'pierre/claude')
  let up = false
  for (let i = 0; i < 50 && !up; i++) { roland.send({ type: 'say', id: 1000 + i, text: '@pierre live-hello' }); await sleep(160); up = p.surfaced.some((t) => /live-hello/.test(String(t))) }
  assert.ok(up, `real container connected + surfaced a LIVE message — surfaced=${JSON.stringify(p.surfaced)} stderr=${p.stderr.join('').slice(0, 400)}`)

  // 2) PROCESS RESTART: kill the container (its next incarnation has a FRESH createInboundDedup). Let the daemon
  //    unbind. The seq for pierre is now well past 0 from the live-hello burst.
  p.proc.kill('SIGKILL'); _procs.delete(p.proc); await sleep(500)

  // 3) Send WHILE DOWN → buffered (pendingDeliveries), assigned a HIGH seq on the resume rebind.
  roland.send({ type: 'say', id: 2000, text: '@pierre BUFFERED-WHILE-DOWN' })
  await sleep(250)

  // 4) Respawn = a FRESH container process, same sessionId → fresh dedup vs a mid-stream daemon. The REAL
  //    receive path must surface the buffered message: resume-token → resequence to 1..K → flushOutbox →
  //    roomStillLive must NOT discard (the frame carries a room) → pushIn. Both regressions on the real container.
  p = bootContainer(port, pierreId, 'pierre/claude')
  const got = await waitSurface(p.surfaced, 'BUFFERED-WHILE-DOWN', 10000)
  assert.ok(got, `the REAL fresh container must SURFACE the buffered-while-down message on resume — surfaced=${JSON.stringify(p.surfaced)} stderr=${p.stderr.join('').slice(0, 400)}`)

  p.proc.kill('SIGKILL'); daemon.stop()
})
