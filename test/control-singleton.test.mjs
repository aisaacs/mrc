// Guard-3 (dashboard-ux floor): the control-socket singleton authority. The control channel moves from a
// browser-reachable TCP port to a unix domain socket; a leftover `.sock` after a crash/SIGKILL must be
// distinguishable from a live owner, and two daemons booting concurrently must not both claim it. The claim
// discipline reuses claimLowestFree's O_EXCL+PID-GC (src/docker.js), but at N=1 there is NO docker mount-oracle
// and no fallback slot, so a recycled-PID false-"held" would strand the WHOLE control plane. The fix (Pierre):
// connect(sock) IS the mount-oracle (a listener ⟺ a live daemon), LAYERED as a past-boot-grace secondary reaper
// on top of the PID gate — never REPLACING the PID gate (which is what keeps a booting owner's fresh claim safe
// during its claim→listen() gap). reconcileControlClaim is the pure decision; tested exhaustively here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileControlClaim } from '../src/proxies/control-singleton.js'

const GRACE = 5_000
const BACKSTOP = 172_800_000
const base = { socketHealthy: false, claimExists: true, pidAlive: true, claimAgeMs: 1_000, bootGraceMs: GRACE, backstopMs: BACKSTOP }

test('a live LISTENER on the socket → DEFER, unconditionally (the mount-oracle positive dominates)', () => {
  // connect() succeeds ⟺ a daemon is serving control → never take over, even if the claim file looks stale/dead.
  assert.equal(reconcileControlClaim({ ...base, socketHealthy: true }), 'defer')
  assert.equal(reconcileControlClaim({ ...base, socketHealthy: true, pidAlive: false }), 'defer')
  assert.equal(reconcileControlClaim({ ...base, socketHealthy: true, claimAgeMs: BACKSTOP + 1 }), 'defer')
})

test('no claim file + nothing listening → CLAIM (free)', () => {
  assert.equal(reconcileControlClaim({ ...base, claimExists: false }), 'claim')
})

test('claim with an affirmatively DEAD pid (ESRCH) + not listening → REAP+CLAIM (the boot-window-safe primary gate)', () => {
  assert.equal(reconcileControlClaim({ ...base, pidAlive: false }), 'reap-claim')
  // dead pid reaps regardless of age — even a fresh dead claim is safe to reap (the writer is gone)
  assert.equal(reconcileControlClaim({ ...base, pidAlive: false, claimAgeMs: 1 }), 'reap-claim')
})

test('INVARIANT — a FRESH claim (pid alive, within boot-grace, not yet listening) is NEVER reaped → DEFER', () => {
  // This is the load-bearing invariant: a booting owner sits in its claim→listen() gap (not listening yet), so
  // connect() refuses — but it's a live, legitimate claim. The PID gate + the boot-grace protect it. If the
  // secondary reaper fired here, two daemons would both bind → split brain. It must DEFER.
  assert.equal(reconcileControlClaim({ ...base, claimAgeMs: 0 }), 'defer')
  assert.equal(reconcileControlClaim({ ...base, claimAgeMs: GRACE - 1 }), 'defer')
})

test('recycled-PID edge (pid alive, past boot-grace, still nothing listening) → REAP+CLAIM (the connect-oracle secondary reaper)', () => {
  // pid alive but no listener AND past the boot window ⇒ either a recycled PID or a daemon that claimed and never
  // bound. Without this, N=1 waits the full 48h backstop = a multi-hour control-plane outage. Collapse it to seconds.
  assert.equal(reconcileControlClaim({ ...base, claimAgeMs: GRACE }), 'reap-claim')
  assert.equal(reconcileControlClaim({ ...base, claimAgeMs: GRACE + 1 }), 'reap-claim')
})

test('48h backstop (pid alive, past backstop) → REAP+CLAIM even if the boot-grace/oracle somehow did not fire', () => {
  assert.equal(reconcileControlClaim({ ...base, claimAgeMs: BACKSTOP }), 'reap-claim')
})

test('the secondary reaper requires BOTH past-grace AND not-listening — a listener past grace still defers', () => {
  // guards against the reaper firing on a live-but-slow owner: if it IS listening, defer regardless of age/pid.
  assert.equal(reconcileControlClaim({ ...base, socketHealthy: true, claimAgeMs: GRACE + 1 }), 'defer')
})
