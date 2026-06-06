// Ambient rooms: ensure the shared host daemon is running and build the env that connects a
// session's channel server to it. (Replaces the old in-process per-pair broker — the daemon is
// a single detached process so it outlives any one session.)
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFreePort } from '../ports.js'

const daemonMetaPath = () => join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json')
const daemonScript = () => fileURLToPath(new URL('../proxies/room-daemon.js', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readMeta = () => { try { return JSON.parse(readFileSync(daemonMetaPath(), 'utf8')) } catch { return null } }

// The daemon is a long-lived host singleton that survives image rebuilds and code edits. Stamp it
// with a content hash of room-daemon.js so a reused daemon running OLD code is detected and
// refreshed — otherwise it answers `register` but not newer frames (e.g. `list`), and every
// session silently sees zero peers.
const daemonVersion = () => {
  try { return createHash('sha1').update(readFileSync(daemonScript())).digest('hex').slice(0, 12) } catch { return '?' }
}

function probeControl(port) {
  return new Promise((res) => {
    if (!port) return res(false)
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify({ action: 'status' }) + '\n'))
    let done = false
    const finish = (v) => { if (!done) { done = true; res(v); try { c.destroy() } catch {} } }
    c.on('data', () => finish(true))
    c.on('error', () => finish(false))
    setTimeout(() => finish(false), 800)
  })
}

function spawnDaemon(port, controlPort, notifyPort) {
  const child = spawn(process.execPath, [daemonScript(), String(port), String(controlPort), String(notifyPort || 0)], { detached: true, stdio: 'ignore' })
  child.unref()
}
async function waitUp(controlPort) {
  for (let i = 0; i < 50; i++) { await sleep(100); if (await probeControl(controlPort)) return true }
  return false
}

// Stop a running daemon: ask it to shut down (graceful), fall back to SIGTERM by recorded pid for
// old daemons that predate the shutdown action, then wait until its control port goes quiet.
async function stopDaemon(meta) {
  await new Promise((res) => {
    const c = net.connect(meta.controlPort, '127.0.0.1', () => c.write(JSON.stringify({ action: 'shutdown' }) + '\n'))
    c.on('data', () => { try { c.destroy() } catch {}; res() })
    c.on('error', () => res())
    setTimeout(() => { try { c.destroy() } catch {}; res() }, 600)
  })
  for (let i = 0; i < 20; i++) { if (!(await probeControl(meta.controlPort))) return true; await sleep(100) }
  if (meta.pid) { try { process.kill(meta.pid) } catch {} }
  for (let i = 0; i < 20; i++) { if (!(await probeControl(meta.controlPort))) return true; await sleep(100) }
  return false
}

// Ensure the singleton room daemon is running CURRENT code; return { port, controlPort, notifyPort }.
export async function ensureRoomDaemon({ portBase, notifyPort }) {
  const version = daemonVersion()
  const meta = readMeta()
  if (meta && await probeControl(meta.controlPort)) {
    if (meta.version === version) return meta   // live and current → reuse
    // Live but running OLD code: refresh in place on the SAME ports so connected sessions reconnect.
    process.stdout.write('  ◎ Refreshing the negotiation-room daemon (code changed)...')
    await stopDaemon(meta)
    spawnDaemon(meta.port, meta.controlPort, meta.notifyPort ?? notifyPort)
    const ok = await waitUp(meta.controlPort)
    console.log(ok ? ' ready.' : ' (could not rebind — booting a fresh one).')
    if (ok) return { port: meta.port, controlPort: meta.controlPort, notifyPort: meta.notifyPort ?? notifyPort, version }
    // else fall through to a fresh daemon on new ports
  }
  const port = await findFreePort(portBase)
  const controlPort = await findFreePort(port + 1)
  process.stdout.write('  ◎ Booting the negotiation-room daemon...')
  spawnDaemon(port, controlPort, notifyPort)
  const ok = await waitUp(controlPort)
  console.log(ok ? ' ready.' : ' slow to start — rooms may be unavailable this session.')
  return { port, controlPort, notifyPort, version }
}

// `mrc rooms restart`: refresh the daemon in place (same ports) so every connected session
// reconnects to fresh code without relaunching.
export async function restartRoomDaemon() {
  const meta = readMeta()
  if (!meta) return { ok: false, error: 'no room daemon recorded yet (start a session first)' }
  await stopDaemon(meta)
  spawnDaemon(meta.port, meta.controlPort, meta.notifyPort || 0)
  const ok = await waitUp(meta.controlPort)
  return ok ? { ok: true, port: meta.port } : { ok: false, error: 'could not rebind — run: pkill -f room-daemon.js' }
}

// Env that connects a session's channel server to the daemon.
export function roomSessionEnv({ daemonPort, sessionId, repoName, roomName, label }) {
  const env = ['-e', `MRC_ROOM_PORT=${daemonPort}`, '-e', `MRC_SESSION_ID=${sessionId}`, '-e', `MRC_REPO_NAME=${repoName}`]
  if (label) env.push('-e', `MRC_ROOM_LABEL=${label}`)
  if (roomName) env.push('-e', `MRC_ROOM=${roomName}`)
  return env
}
