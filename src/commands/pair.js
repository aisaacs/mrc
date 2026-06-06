// Ambient rooms: ensure the shared host daemon is running and build the env that connects a
// session's channel server to it. (Replaces the old in-process per-pair broker — the daemon is
// a single detached process so it outlives any one session.)
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFreePort } from '../ports.js'

const daemonMetaPath = () => join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// Ensure the singleton room daemon is running; return { port, controlPort }. Reuses a live one.
export async function ensureRoomDaemon({ portBase, notifyPort }) {
  try {
    const m = JSON.parse(readFileSync(daemonMetaPath(), 'utf8'))
    if (await probeControl(m.controlPort)) return m
  } catch {}
  const port = await findFreePort(portBase)
  const controlPort = await findFreePort(port + 1)
  const script = fileURLToPath(new URL('../proxies/room-daemon.js', import.meta.url))
  process.stdout.write('  ◎ Booting the negotiation-room daemon...')
  const child = spawn(process.execPath, [script, String(port), String(controlPort), String(notifyPort || 0)], { detached: true, stdio: 'ignore' })
  child.unref()
  let up = false
  for (let i = 0; i < 50; i++) { await sleep(100); if (await probeControl(controlPort)) { up = true; break } }
  console.log(up ? ' ready.' : ' slow to start — rooms may be unavailable this session.')
  return { port, controlPort, notifyPort }
}

// Env that connects a session's channel server to the daemon.
export function roomSessionEnv({ daemonPort, sessionId, repoName, roomName, label }) {
  const env = ['-e', `MRC_ROOM_PORT=${daemonPort}`, '-e', `MRC_SESSION_ID=${sessionId}`, '-e', `MRC_REPO_NAME=${repoName}`]
  if (label) env.push('-e', `MRC_ROOM_LABEL=${label}`)
  if (roomName) env.push('-e', `MRC_ROOM=${roomName}`)
  return env
}
