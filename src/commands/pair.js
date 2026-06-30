// Ambient rooms: ensure the shared host daemon is running and build the env that connects a
// session's channel server to it. (Replaces the old in-process per-pair broker — the daemon is
// a single detached process so it outlives any one session.)
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findFreePort } from '../ports.js'
import { daemonVersion } from '../daemon-version.js'

const daemonMetaPath = () => join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json')
const daemonScript = () => fileURLToPath(new URL('../proxies/room-daemon.js', import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const readMeta = () => { try { return JSON.parse(readFileSync(daemonMetaPath(), 'utf8')) } catch { return null } }

// The daemon is a long-lived host singleton that survives image rebuilds and code edits. Stamp it with
// a content hash of the WHOLE src/ tree (#21b — see daemon-version.js) so a reused daemon running ANY
// stale module (engine/trust/telegram/config/…) is detected and refreshed — not just room-daemon.js.
// Otherwise it answers `register` but runs old logic, and the version check can't even see the drift.

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

// #45: the AUTHORITATIVE "is the daemon really gone" check — can we BIND its port? probeControl ("does
// something answer the control port") is necessary but not sufficient: a wedged daemon can hold the LISTEN
// port without answering, and a respawn would then EADDRINUSE and the OLD process keep serving stale code.
// portFree tests the exact condition the respawn faces. Returns true iff the port is bindable on 127.0.0.1.
export function portFree(port) {
  return new Promise((res) => {
    if (!port) return res(true)
    const s = net.createServer()
    s.once('error', () => res(false))           // EADDRINUSE → still held
    s.once('listening', () => s.close(() => res(true)))
    s.listen(port, '127.0.0.1')
  })
}
// #45: find the REAL room-daemon process LISTENING on a port — the recorded pid in room-daemon.json may be
// stale/wrong (a crash, a recycled pid), so killing it frees nothing and the wedged daemon survives. Resolve
// the actual holder via lsof, then VERIFY each is our daemon (its command contains room-daemon.js) before the
// caller would kill it — so we never kill an unrelated process that happened to be recycled onto the port.
// Best-effort: returns [] if lsof/ps are unavailable (then the recorded-pid path is all we have).
export function roomDaemonPidsOnPort(port) {
  if (!port) return []
  let out = ''
  try { out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return [] }
  const pids = [...new Set(out.split('\n').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))]
  return pids.filter((pid) => {
    // Verify the holder is genuinely OUR daemon before any SIGKILL. `-ww` disables ps width-truncation so a long
    // install path can't cut off "room-daemon.js" (a false negative that would leave the wedged daemon alive);
    // and a listener whose command does NOT match (a recycled/unrelated pid) is NOT killed (no innocent kill).
    // A process whose command merely *mentions* room-daemon.js (e.g. an editor) won't be here — lsof already
    // filtered to LISTENERS on this exact port, and only the daemon listens there.
    try { return /[/ ]room-daemon\.js(\s|$)/.test(execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) } catch { return false }   // anchored on a path-/ or arg-space boundary so `my-room-daemon.js` can't match (Roland's precision note)
  })
}

// Stop a running daemon and CONFIRM its ports are FREE (so a same-port respawn won't EADDRINUSE and leave the
// old, stale daemon serving — #21/#45). Escalate, confirming bindability after EACH step: graceful shutdown →
// SIGTERM by recorded pid → SIGKILL by pid → #45: SIGKILL the REAL holder found by port (defeats a stale
// recorded pid). Returns true only when both ports are actually bindable; false → the caller fails loud.
// Dependencies are injectable so the escalation is unit-testable without spawning real processes.
export async function stopDaemon(meta, deps = {}) {
  const kill = deps.kill || ((pid, sig) => { try { process.kill(pid, sig) } catch {} })
  const free = deps.free || (async () => (await portFree(meta.port)) && (await portFree(meta.controlPort)))
  const findPids = deps.findPids || (() => [...new Set([...roomDaemonPidsOnPort(meta.port), ...roomDaemonPidsOnPort(meta.controlPort)])])
  const slp = deps.sleep || sleep
  const shutdown = deps.shutdown || (() => new Promise((res) => {
    const c = net.connect(meta.controlPort, '127.0.0.1', () => c.write(JSON.stringify({ action: 'shutdown' }) + '\n'))
    c.on('data', () => { try { c.destroy() } catch {}; res() })
    c.on('error', () => res())
    setTimeout(() => { try { c.destroy() } catch {}; res() }, 600)
  }))
  const poll = async (n) => { for (let i = 0; i < n; i++) { if (await free()) return true; await slp(100) } return false }
  await shutdown()
  if (await poll(20)) return true
  if (meta.pid) kill(meta.pid, 'SIGTERM')
  if (await poll(15)) return true
  if (meta.pid) kill(meta.pid, 'SIGKILL')                       // wedged — force the recorded pid down
  if (await poll(10)) return true
  for (const pid of findPids()) kill(pid, 'SIGKILL')            // #45: recorded pid was stale → kill the REAL holder of the port
  if (await poll(15)) return true
  return false                                                  // genuinely couldn't free the port → caller fails loud
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
  // #45: stopDaemon now escalates to SIGKILL-ing the REAL port holder (defeating a stale recorded pid) and
  // confirms the port is actually bindable. If it STILL can't free it, fail loud — the only thing that leaves
  // is an environment without lsof/ps (so the real holder couldn't be found): then the manual remedy applies.
  if (!stopped) return { ok: false, error: 'could not free the daemon port automatically (the wedged process resisted SIGKILL or lsof/ps is unavailable to find it). Last resort: pkill -f room-daemon.js, then retry' }
  spawnDaemon(meta.port, meta.controlPort, meta.notifyPort || 0)
  // Confirm the CURRENT code is the one now answering — not a stale daemon (#21). waitUp alone would
  // false-succeed if the old process had survived; the version check is what makes the restart honest.
  const ok = await waitUpVersion(meta.controlPort, version)
  return ok ? { ok: true, port: meta.port, version } : { ok: false, error: 'new daemon did not come up on current code (port freed but the fresh boot did not take it) — run: pkill -f room-daemon.js, then retry' }
}

// `mrc rooms stop`: stop the daemon without respawning, and clear its record.
export async function stopRoomDaemon() {
  const meta = readMeta()
  if (!meta) return { ok: false, error: 'no room daemon running' }
  const stopped = await stopDaemon(meta)
  if (stopped) { try { unlinkSync(daemonMetaPath()) } catch {} }
  return stopped ? { ok: true } : { ok: false, error: 'could not free the daemon port automatically (resisted SIGKILL or lsof/ps unavailable). Last resort: pkill -f room-daemon.js' }
}

// Env that connects a session's channel server to the daemon.
export function roomSessionEnv({ daemonPort, sessionId, repoName, roomName, label }) {
  const env = ['-e', `MRC_ROOM_PORT=${daemonPort}`, '-e', `MRC_SESSION_ID=${sessionId}`, '-e', `MRC_REPO_NAME=${repoName}`]
  if (label) env.push('-e', `MRC_ROOM_LABEL=${label}`)
  if (roomName) env.push('-e', `MRC_ROOM=${roomName}`)
  return env
}
