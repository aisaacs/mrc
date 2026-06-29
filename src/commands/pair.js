// Ambient rooms: ensure the shared host daemon is running and build the env that connects a
// session's channel server to it. (Replaces the old in-process per-pair broker — the daemon is
// a single detached process so it outlives any one session.)
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
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
    if (meta.version === version) { console.log('  ◎ Negotiation-room daemon ready.'); return meta }   // live and current → reuse
    // Live but running OLD code: refresh in place on the SAME ports so connected sessions reconnect.
    process.stdout.write('  ◎ Refreshing the negotiation-room daemon (code changed)...')
    await stopDaemon(meta)
    spawnDaemon(meta.port, meta.controlPort, meta.notifyPort ?? notifyPort)
    const ok = await waitUp(meta.controlPort)
    console.log(ok ? ' ready.' : ' (could not rebind — booting a fresh one).')
    if (ok) return { port: meta.port, controlPort: meta.controlPort, notifyPort: meta.notifyPort ?? notifyPort, version }
    // else fall through to a fresh daemon on new ports
  }
  // #50: prefer the last-known port (from a crashed / idle-shut-down / `mrc rooms stop` tombstone
  // record) so a relaunch RE-BINDS the port live sessions are pinned to — both in their env
  // (MRC_ROOM_PORT) and in their container firewall allowlist (init-firewall.sh HOST_PORTS) — and they
  // reconnect on their own via the channel server's retry. findFreePort only scans past it if it's
  // actually taken (in which case those sessions are stranded by the cage and must relaunch).
  const port = await findFreePort(meta?.port || portBase)
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
  if (!meta) {
    // #37: no daemon recorded at all (never started) → COLD-START a fresh one via the same proven path
    // a session launch uses, instead of erroring "start a session first". It idle-shuts-down ~10min
    // later if nothing connects, so a no-op restart can't leak a stray daemon. (After `mrc rooms stop`
    // the record now SURVIVES as a tombstone — #50 — so that path falls through below and reuses its port.)
    const d = await ensureRoomDaemon({ portBase: Number(process.env.MRC_PORT_BASE) || 7722, notifyPort: 0 })
    const up = d && await probeControl(d.controlPort)
    return up ? { ok: true, port: d.port, coldStarted: true } : { ok: false, error: 'could not boot a room daemon — run: pkill -f room-daemon.js, then try again' }
  }
  // Stop it only if it's actually up (a tombstoned/crashed record is already down).
  if (await probeControl(meta.controlPort)) await stopDaemon(meta)
  // #50: REBIND the recorded port so live sessions — pinned to it in their env AND their firewall
  // allowlist — reconnect on their own. findFreePort returns meta.port when free and only scans past it
  // if it got taken; if it had to MOVE, live sessions are stranded by the cage and must relaunch (moved).
  const port = await findFreePort(meta.port)
  const controlPort = await findFreePort(port + 1)
  spawnDaemon(port, controlPort, meta.notifyPort || 0)
  const ok = await waitUp(controlPort)
  return ok ? { ok: true, port, moved: port !== meta.port } : { ok: false, error: 'could not rebind — run: pkill -f room-daemon.js' }
}

// `mrc rooms stop`: stop the daemon without respawning. Leave a TOMBSTONE (record kept, marked
// stopped) instead of unlinking — #50 — so a later `restart` / session launch RE-BINDS the same port
// and any still-live sessions reconnect on their own (they're pinned to that port in env + firewall).
// The daemon overwrites the tombstone with a fresh record (no `stopped`) when it next boots.
export async function stopRoomDaemon() {
  const meta = readMeta()
  if (!meta || meta.stopped) return { ok: false, error: 'no room daemon running' }
  const stopped = await stopDaemon(meta)
  if (stopped) { try { writeFileSync(daemonMetaPath(), JSON.stringify({ ...meta, stopped: true }, null, 2)) } catch {} }
  return stopped ? { ok: true } : { ok: false, error: 'could not stop — run: pkill -f room-daemon.js' }
}

// Env that connects a session's channel server to the daemon.
export function roomSessionEnv({ daemonPort, sessionId, repoName, repoPath, roomName, label, summonedBy, secret }) {
  const env = ['-e', `MRC_ROOM_PORT=${daemonPort}`, '-e', `MRC_SESSION_ID=${sessionId}`, '-e', `MRC_REPO_NAME=${repoName}`]
  if (repoPath) env.push('-e', `MRC_REPO_PATH=${repoPath}`)   // host path, so the daemon can summon an adversary onto this same repo
  if (label) env.push('-e', `MRC_ROOM_LABEL=${label}`)
  if (roomName) env.push('-e', `MRC_ROOM=${roomName}`)
  if (summonedBy) env.push('-e', `MRC_SUMMONED_BY=${summonedBy}`)   // a spawned adversary reports this → daemon auto-pairs it with the summoner
  if (secret) env.push('-e', `MRC_ROOM_SECRET=${secret}`)   // G/#44: per-session register secret — the channel server echoes it so the daemon can tell a legit reconnect from an impersonator
  return env
}
