// Guard-3 (dashboard-ux floor) — the control-socket singleton authority.
//
// The daemon's control channel moves from a browser-reachable TCP port to a unix domain socket (a browser cannot
// open a unix socket → the cross-protocol control-frame-injection vuln dies at the transport). But a unix socket
// is a FILE: a crash/SIGKILL leaves a stale `.sock`, and two daemons booting concurrently must not both claim it.
//
// Ownership reuses claimLowestFree's O_EXCL+PID-GC discipline (src/docker.js) — BUT at N=1 there is no docker
// mount-oracle and no fallback slot, so claimLowestFree's benign recycled-PID tolerance (a wasted slot for ≤48h)
// becomes a CATASTROPHE (a recycled PID reading "held forever" ⇒ NO daemon can own control ⇒ the whole control
// plane is dead until the 48h backstop). The fix (Pierre): connect(sock) IS the singleton's mount-oracle — a
// listener ⟺ a live daemon serving control, immune to PID recycling — LAYERED on top of the PID gate, never
// replacing it. The PID gate is what keeps a booting owner's fresh claim safe during its claim→listen() gap; the
// connect-oracle only reaps the recycled-PID edge (pid alive, past a short boot-grace, still nothing listening),
// collapsing the N=1 outage from 48h to seconds while NEVER reaping a fresh live claim.
//
// reconcileControlClaim is the PURE decision (like reconcileSealDecision) — no I/O, exhaustively tested. Returns:
//   'defer'      — a live/booting owner exists; do NOT take control.
//   'claim'      — free; create the O_EXCL claim + bind the socket.
//   'reap-claim' — a stale claim (dead pid / past backstop / recycled-PID edge); remove it, then claim.
//
// `socketHealthy` = the I/O probe connected AND got a health-ping PONG within its timeout — NOT merely that a
// connection was accepted. That distinction matters (Pierre): a WEDGED daemon (accepts connections, processes
// nothing) would make a bare connect() succeed forever → unreapable. A health-PING makes the wedged accept-but-
// silent daemon read `socketHealthy:false` → it falls through to the past-grace reaper and IS recoverable.
// `claimAgeMs` MUST be clamped `>= 0` by the caller (a future/skewed mtime → negative age would else never reach
// the grace/backstop thresholds → defer forever).
export function reconcileControlClaim({ socketHealthy, claimExists, pidAlive, claimAgeMs, bootGraceMs, backstopMs }) {
  // The mount-oracle POSITIVE dominates everything: a healthy daemon is serving control right now, so never take
  // over — even if the claim file looks stale/dead (it's about to be rewritten by the live owner).
  if (socketHealthy) return 'defer'
  if (!claimExists) return 'claim'                     // no owner recorded and nothing healthy → free
  if (!pidAlive) return 'reap-claim'                   // affirmatively dead (ESRCH) — the boot-window-safe primary gate
  if (claimAgeMs >= backstopMs) return 'reap-claim'    // last-ditch 48h backstop (only reaches a NOT-healthy holder — a wedged listener is caught by the health-ping above, not this)
  // The health-oracle SECONDARY reaper — fires ONLY past the boot-grace AND with the daemon NOT healthy: pid alive
  // but not serving + past its boot window ⇒ a recycled PID, a claim-that-never-bound, or a wedged listener.
  // Requires BOTH conditions so a healthy owner is never reaped, and a genuinely-booting owner (within grace) is never reaped.
  if (claimAgeMs >= bootGraceMs) return 'reap-claim'
  // Fresh claim, pid alive, within the boot-grace, not yet healthy — a booting owner in its claim→listen() gap.
  // THE load-bearing invariant: never reap this, or two daemons both bind → split brain.
  return 'defer'
}

import net from 'node:net'
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

// The health-PING probe = the socketHealthy oracle. Connect to the control unix socket, send a status frame, and
// resolve true ONLY if a well-formed response line comes back within `timeoutMs`. A bare "connection accepted" is
// NOT enough (a wedged daemon accepts but never answers) — a PONG proves the daemon is actually serving. Err the
// timeout LONG (Pierre): a false "unhealthy" reaps a healthy-but-loaded daemon mid-life = the split brain we avoid.
export function probeControlHealthy(sockPath, timeoutMs = 2000) {
  return new Promise((res) => {
    let done = false; let buf = ''
    const finish = (v) => { if (!done) { done = true; res(v); try { c.destroy() } catch {} } }
    const c = net.connect(sockPath, () => { try { c.write(JSON.stringify({ action: 'status' }) + '\n') } catch { finish(false) } })
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { finish(!!JSON.parse(buf.slice(0, i))) } catch { finish(false) } } })
    c.on('error', () => finish(false))
    setTimeout(() => finish(false), timeoutMs)
  })
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e && e.code !== 'ESRCH' } }   // EPERM (alive, not ours) → keep; ESRCH → dead

// Acquire the control-socket singleton claim. Reads the claim file + health-pings the socket, runs the pure
// reconcileControlClaim, and performs the reap/claim I/O. Returns { owned, reaped }. The CLAIM is the atomic O_EXCL
// lock (`wx`, claimLowestFree discipline) with a trailing-newline sentinel; the SOCKET is unlinked when we reap a
// stale owner so the subsequent bind can't EADDRINUSE on a leftover file. I/O is injectable for tests.
export async function acquireControlClaim({ claimPath, sockPath, bootGraceMs = 8_000, backstopMs = 172_800_000, probe = probeControlHealthy, now = () => Date.now(), pid = process.pid }) {
  const socketHealthy = existsSync(sockPath) ? await probe(sockPath) : false
  const claimExists = existsSync(claimPath)
  let claimPid = null, claimAgeMs = 0
  if (claimExists) {
    try { const m = readFileSync(claimPath, 'utf8').match(/^(\d+)\n/); claimPid = m ? parseInt(m[1], 10) : null } catch {}
    try { claimAgeMs = Math.max(0, now() - statSync(claimPath).mtimeMs) } catch { claimAgeMs = 0 }   // clamp: a future/skewed mtime must not read as "ancient" nor "future-forever-fresh"
  }
  const decision = reconcileControlClaim({ socketHealthy, claimExists, pidAlive: claimPid != null ? pidAlive(claimPid) : false, claimAgeMs, bootGraceMs, backstopMs })
  if (decision === 'defer') return { owned: false, reaped: false }
  const reaped = decision === 'reap-claim'
  if (reaped) { try { unlinkSync(claimPath) } catch {} }               // reap only the stale CLAIM here — the O_EXCL wx-write below is the mutex
  try { writeFileSync(claimPath, `${pid}\n`, { flag: 'wx' }) }         // atomic O_EXCL: a concurrent claimer that beat us here makes this EEXIST → we lost, defer (never bind)
  catch (e) { if (e && e.code === 'EEXIST') return { owned: false, reaped }; throw e }
  // NOTE: the stale SOCKET file is unlinked in bindControlSocket — AFTER this claim is won — so the claim mutex
  // serializes unlink+bind and a concurrent daemon can never unlink our fresh socket (Pierre). We only reach bind
  // when owned, which (by reconcile) means the socket was NOT healthy → unlinking it there is our-stale, safe.
  return { owned: true, reaped }
}

// Bind the control unix socket with the perms sequence: chmod the PARENT DIR 0700 FIRST (closes the traverse-
// before-chmod window — no other local user can even reach the socket path), then unlink any leftover, then
// listen, then chmod the socket 0600. Dir-0700 is the load-bearing perm; the socket chmod is belt. Returns the
// bound server. (macOS `sun_path` ~104-char cap is the caller's concern — keep the path short.)
export function bindControlSocket(server, sockPath) {
  mkdirSync(dirname(sockPath), { recursive: true })
  try { chmodSync(dirname(sockPath), 0o700) } catch {}     // FIRST — nobody can traverse to the socket while we bind
  try { if (existsSync(sockPath)) unlinkSync(sockPath) } catch {}   // we own the claim → any leftover here is ours-stale
  server.listen(sockPath, () => { try { chmodSync(sockPath, 0o600) } catch {} })
  return server
}
