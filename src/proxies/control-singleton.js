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
export function reconcileControlClaim({ socketListening, claimExists, pidAlive, claimAgeMs, bootGraceMs, backstopMs }) {
  // The mount-oracle POSITIVE dominates everything: if connect() succeeds a daemon is serving control right now,
  // so never take over — even if the claim file looks stale/dead (it's about to be rewritten by the live owner).
  if (socketListening) return 'defer'
  if (!claimExists) return 'claim'                     // no owner recorded and nothing listening → free
  if (!pidAlive) return 'reap-claim'                   // affirmatively dead (ESRCH) — the boot-window-safe primary gate
  if (claimAgeMs >= backstopMs) return 'reap-claim'    // last-ditch 48h backstop (a wedged/recycled holder)
  // The connect-oracle SECONDARY reaper — fires ONLY past the boot-grace AND with nothing listening: pid alive but
  // no listener + past its boot window ⇒ a recycled PID or a claim-that-never-bound. Requires BOTH conditions so a
  // live-but-slow owner (still listening) is never reaped, and a genuinely-booting owner (within grace) is never reaped.
  if (claimAgeMs >= bootGraceMs) return 'reap-claim'
  // Fresh claim, pid alive, within the boot-grace, not yet listening — a booting owner in its claim→listen() gap.
  // THE load-bearing invariant: never reap this, or two daemons both bind → split brain.
  return 'defer'
}
