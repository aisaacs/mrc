// Ambient rooms: ensure the shared host daemon is running and build the env that connects a
// session's channel server to it. (Replaces the old in-process per-pair broker — the daemon is
// a single detached process so it outlives any one session.)
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
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

// Like probeControl, but returns the daemon's reported code version (or null). Used to confirm the
// process answering the control port is the FRESH one — not an old daemon that survived a failed stop
// (the new one would have EADDRINUSE-exited). Without this, a stale daemon reads as "up" and we'd
// silently keep serving old code across a restart (#21 — the post-restart cluster's root cause).
export function probeVersion(port) {
  return new Promise((res) => {
    if (!port) return res(null)
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify({ action: 'status' }) + '\n'))
    let buf = ''; let done = false
    const finish = (v) => { if (!done) { done = true; res(v); try { c.destroy() } catch {} } }
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { finish(JSON.parse(buf.slice(0, i)).version ?? null) } catch { finish(null) } } })
    c.on('error', () => finish(null))
    setTimeout(() => finish(null), 800)
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
// Wait until the control port reports the EXPECTED version — i.e. the fresh daemon actually took the
// port. Distinguishes "a new daemon bound" from "the old one is still answering" (the #21 stale-daemon
// false-success: if the new daemon EADDRINUSE-exits because the old one survived the stop, probeControl
// would still say "up" — but the version would be the OLD one, which this rejects).
export async function waitUpVersion(controlPort, expected, attempts = 50) {
  for (let i = 0; i < attempts; i++) { await sleep(100); if ((await probeVersion(controlPort)) === expected) return true }
  return false
}

// Stop a running daemon and CONFIRM the port is freed (so a same-port respawn won't EADDRINUSE). Escalate:
// graceful shutdown → SIGTERM by recorded pid → SIGKILL by pid (last resort — a wedged daemon that
// ignores the first two must not survive a restart and leave stale code serving, which is #21).
async function stopDaemon(meta) {
  await new Promise((res) => {
    const c = net.connect(meta.controlPort, '127.0.0.1', () => c.write(JSON.stringify({ action: 'shutdown' }) + '\n'))
    c.on('data', () => { try { c.destroy() } catch {}; res() })
    c.on('error', () => res())
    setTimeout(() => { try { c.destroy() } catch {}; res() }, 600)
  })
  for (let i = 0; i < 20; i++) { if (!(await probeControl(meta.controlPort))) return true; await sleep(100) }
  if (meta.pid) { try { process.kill(meta.pid, 'SIGTERM') } catch {} }
  for (let i = 0; i < 15; i++) { if (!(await probeControl(meta.controlPort))) return true; await sleep(100) }
  if (meta.pid) { try { process.kill(meta.pid, 'SIGKILL') } catch {} }   // wedged — force it down so the port frees
  for (let i = 0; i < 15; i++) { if (!(await probeControl(meta.controlPort))) return true; await sleep(100) }
  return false
}

// Ensure the singleton room daemon is running CURRENT code; return { port, controlPort, notifyPort }.
export async function ensureRoomDaemon({ portBase, notifyPort }) {
  const version = daemonVersion()
  const meta = readMeta()
  if (meta && await probeControl(meta.controlPort)) {
    if (meta.version === version) { console.log('  ◎ Negotiation-room daemon ready.'); return meta }   // live and current → reuse
    // Live but running OLD code: refresh in place on the SAME ports so connected sessions reconnect.
    process.stdout.write('  ◎ Refreshing the negotiation-room daemon (code changed)...')
    await stopDaemon(meta)
    spawnDaemon(meta.port, meta.controlPort, meta.notifyPort ?? notifyPort)
    // Verify the FRESH version answers (not the old daemon surviving a failed stop, #21) before reusing
    // the same ports; otherwise fall through to a brand-new daemon on free ports.
    const ok = await waitUpVersion(meta.controlPort, version)
    console.log(ok ? ' ready.' : ' (could not rebind to current code — booting a fresh one).')
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
  const version = daemonVersion()
  const stopped = await stopDaemon(meta)
  if (!stopped) return { ok: false, error: 'old daemon would not stop (still bound to its port) — run: pkill -f room-daemon.js, then retry' }
  spawnDaemon(meta.port, meta.controlPort, meta.notifyPort || 0)
  // Confirm the CURRENT code is the one now answering — not a stale daemon (#21). waitUp alone would
  // false-succeed if the old process had survived; the version check is what makes the restart honest.
  const ok = await waitUpVersion(meta.controlPort, version)
  return ok ? { ok: true, port: meta.port, version } : { ok: false, error: 'new daemon did not come up on current code — run: pkill -f room-daemon.js' }
}

// `mrc rooms stop`: stop the daemon without respawning, and clear its record.
export async function stopRoomDaemon() {
  const meta = readMeta()
  if (!meta) return { ok: false, error: 'no room daemon running' }
  const stopped = await stopDaemon(meta)
  if (stopped) { try { unlinkSync(daemonMetaPath()) } catch {} }
  return stopped ? { ok: true } : { ok: false, error: 'could not stop — run: pkill -f room-daemon.js' }
}

// Env that connects a session's channel server to the daemon.
export function roomSessionEnv({ daemonPort, sessionId, repoName, roomName, label }) {
  const env = ['-e', `MRC_ROOM_PORT=${daemonPort}`, '-e', `MRC_SESSION_ID=${sessionId}`, '-e', `MRC_REPO_NAME=${repoName}`]
  if (label) env.push('-e', `MRC_ROOM_LABEL=${label}`)
  if (roomName) env.push('-e', `MRC_ROOM=${roomName}`)
  return env
}
