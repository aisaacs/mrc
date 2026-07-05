// seal.js — the CONTAINER-LIFETIME SNI sidecar (#49, 4b) + its lifecycle helpers.
//
// WHY a sidecar: the cage's egress seal used to live IN the launcher process (mrc.js), which dies with the
// foreground session. Born-detachable (Option A) severs launcher-lifetime from container-lifetime — a dtach
// master can be reaped while the caged container runs on — so the seal must outlive the launcher and be tied
// to the CONTAINER instead. This module IS the standalone seal process (run directly, it starts the
// SNI-pinning proxy + writes a readiness portfile) AND the host-side lifecycle around it (spawn / probe /
// ensure-ready / reap). The daemon reaps it by nonce when the container dies (#41 reconcile); an
// orphaned-caged container is killed as the fail-closed backstop.
//
// THE ONE SENTENCE (Pierre): every cross-process handoff keys on a DETERMINISTIC identity (the nonce =
// memberSessionId, never a pid/port), and containment never rests on the reap reconcile being perfect —
// hence CLIENT-AUTH (MRC_ROOM_SECRET), which makes a port-reuse hand egress to no one.
import { spawn, execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startSniProxy } from './sni-proxy.js'
import { findFreePort } from '../ports.js'

const SEAL_JS = fileURLToPath(import.meta.url)
const sealDir = () => join(homedir(), '.local', 'share', 'mrc', 'seals')
// Portfile keyed on the NONCE (memberSessionId) — a deterministic identity known BEFORE `docker run`, so the
// container-label ↔ portfile match the daemon reaps by never depends on a pid or the late docker-assigned id.
export function sealPortfilePath(nonce) { return join(sealDir(), `${String(nonce)}.json`) }

export function readSealPortfile(nonce) {
  try { return JSON.parse(readFileSync(sealPortfilePath(nonce), 'utf8')) } catch { return null }
}
export function writeSealPortfile(nonce, data) {
  const p = sealPortfilePath(nonce)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, p)   // atomic publish — a reader never sees a half-written portfile
}
export function removeSealPortfile(nonce) { try { unlinkSync(sealPortfilePath(nonce)) } catch {} }

// THREE-STATE liveness (Pierre — never collapse them). Probe = connect + complete the proxy-auth handshake:
//   'alive'              — connected + authed 200 → a live seal holding THIS secret
//   'alive-wrong-secret' — connected + 407 → a live process on the port, DIFFERENT secret (still alive!)
//   'dead'               — connection refused / no HTTP status / timeout → gone
// Collapsing wrong-secret into dead would double-spawn over a live-but-wedged seal; collapsing it into alive
// would treat a foreign process as our seal. The auth handshake is BOTH the client-scope gate and the oracle.
export function probeSeal(port, secret, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (s) => { if (done) return; done = true; try { c.destroy() } catch {}; resolve(s) }
    const c = connect({ host: '127.0.0.1', port: Number(port) }, () => {
      const authb64 = Buffer.from(`mrc:${secret}`).toString('base64')
      c.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\nProxy-Authorization: Basic ${authb64}\r\n\r\n`)
    })
    let buf = ''
    c.on('data', (d) => {
      buf += d.toString('latin1')
      const nl = buf.indexOf('\r\n')
      if (nl < 0) return
      const line = buf.slice(0, nl)
      if (/^HTTP\/1\.[01]\s+200/.test(line)) return finish('alive')
      if (/^HTTP\/1\.[01]\s+407/.test(line)) return finish('alive-wrong-secret')
      finish('dead')   // any other status = not a healthy seal
    })
    c.on('error', () => finish('dead'))    // ECONNREFUSED, reset, etc.
    c.on('close', () => finish('dead'))    // closed before a status line
    const t = setTimeout(() => finish('dead'), timeoutMs); t.unref?.()
  })
}

// Is a seal live for this nonce? Reads the portfile for the port, then probes with auth — NEVER pid/existence
// (a recycled pid or a stale portfile pointing at a reused port both fail the auth handshake → not our seal).
export async function sealAliveForNonce(nonce, secret, opts = {}) {
  const pf = readSealPortfile(nonce)
  if (!pf?.port) return 'dead'
  return probeSeal(pf.port, secret, opts.timeoutMs)
}

// Spawn the detached sidecar (survives the launcher/master dying). Returns its pid (informational only — the
// reap keys on the nonce/portfile, never this pid).
export function spawnSeal({ nonce, secret, port, allowlist, freshness }) {
  const args = [SEAL_JS, String(port), '--auth', secret, '--portfile', sealPortfilePath(nonce), '--freshness', String(freshness)]
  if (allowlist?.length) args.push('--allow', allowlist.join(','))
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return child.pid
}

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Find the sidecar's PID(s) by the NONCE in its command line — spawnSeal puts `--portfile <…>/<nonce>.json`
// on the argv, so the nonce is in the process cmdline. This mirrors pidsForSock (team.js:191, which matches
// the SOCK, not a stored pid): drift-proof + pid-reuse-safe, so the KILL step never signals a recycled pid
// that now belongs to an unrelated host process (the #41 hazard walking back in at the kill, even after a
// clean nonce MATCH). Anchored on `<nonce>.json` so it can't collide with an unrelated process.
//   freshness (optional, Strike A): the nonce is REUSED across resume, so a bare nonce match can hit a
//   RESUME's fresh seal too. Passing the freshness (also on the argv, `--freshness <tok>`) scopes the match
//   to the SPECIFIC instance you observed die — a resume's seal has a different freshness → never matched.
export function sealPidsForNonce(nonce, freshness = null) {
  const pat = freshness
    ? `seal\\.js.*${reEsc(nonce)}\\.json.*--freshness ${reEsc(freshness)}`
    : `seal\\.js.*${reEsc(nonce)}\\.json`
  try { return execFileSync('pgrep', ['-f', pat], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean) }
  catch { return [] }   // pgrep exit 1 = ran, no match = legit empty
}
// Is the seal PROCESS alive for this nonce (by cmdline, never a stored pid)? The daemon's reconcile uses THIS
// for its two hygiene decisions — container-up + seal-process-absent ⟹ kill the unsealed zombie container;
// container-absent + seal-process-present ⟹ reap the orphaned sidecar. Distinct from sealAliveForNonce (the
// launcher's AUTH probe, which additionally distinguishes wrong-secret for the respawn decision).
export function sealProcessAlive(nonce) { return sealPidsForNonce(nonce).length > 0 }

// Reap the sidecar for a nonce when its container is gone: pgrep-match by nonce (NEVER pf.pid), SIGTERM then
// SIGKILL any survivor, remove the portfile. This is HYGIENE — it removes the now-unsealed corpse. It is NOT
// the containment mechanism and is timing-INDEPENDENT of it: egress is already sealed-or-refused by
// construction (the in-container firewall drops direct egress + a dead seal port = ECONNREFUSED), instantly,
// the microsecond the seal dies. "Refused instantly, killed eventually."
export function reapSealForNonce(nonce, freshness = null) {
  const pids = sealPidsForNonce(nonce, freshness).map(Number)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  if (pids.length) { const t = setTimeout(() => { for (const pid of pids) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch {} } }, 500); t.unref?.() }
  removeSealPortfile(nonce)
  return pids.length > 0
}

// PURE decision for the daemon's seal reconcile — given the live facts, decide which zombie containers to KILL
// and which orphaned seals to REAP, honoring the two lessons the nonce-reuse fact forces:
//  • KILL (container up, its seal dead) FAILS-TOWARD-STARTING (Strike B / team.js:267): a caged container is
//    killed ONLY if it is PAST the seal-boot grace AND its seal is not alive — a booting seal isn't yet
//    pgrep-visible, so killing within grace murders a healthy launch. Inconclusive → leave it (starting).
//  • REAP (seal alive, orphaned) re-checks CONTAINER-PRESENCE-BY-LABEL at decision time (Strike A): a seal is
//    reaped ONLY if NO live container still carries its nonce label. A resume reuses the nonce, so a stale
//    "the container I saw die" observation would reap the seal the RESUME is now using. Re-checking
//    liveSealNonces at decision time (never a remembered death) cancels the reap whenever the nonce is still
//    in service. (The reap ITSELF is additionally freshness-scoped — belt — so it targets the dead instance.)
// STRIKE D (documented, accepted): sealAlive here is pgrep (process EXISTS), not the auth handshake. A WEDGED
// seal (process up, not sealing) passes pgrep → not killed → the container runs MUTE but still egress-safe
// (firewall + dead/hung port refuse egress regardless). Conservative for CONTAINMENT (never a false-kill),
// but a silent AVAILABILITY hole: a wedged seal dangles unreaped until the human notices Pierre gone quiet.
// Accepted for now; the fix (if it bites) is an auth-liveness recheck on the reap path to recycle a wedged seal.
// BOTH branches fail-toward-starting with a grace, symmetric (Strike E): the KILL branch waits out the
// seal's BOOT (a booting seal isn't yet pgrep-visible → don't kill its container), and the REAP branch waits
// out the container's LAUNCH-REGISTRATION (a freshly-spawned seal's container isn't yet LABEL-visible in
// `docker ps` → don't reap its seal). Leaving the reap branch bare (as a first cut did) reaps a RESUME's
// fresh seal in the sub-second before `docker run` registers the label — re-reading liveSealNonces doesn't
// help because the label isn't there YET (a TOCTOU). A genuine orphan is always PAST the reap grace; a
// resume's fresh seal is always WITHIN it (portfile mtime is the clock — written post-listen()).
//   liveSealNonces:  Set<nonce> from live containers' mrc.seal labels (docker ps, re-read at decision time)
//   allSealNonces:   iterable<nonce> of seals that might need reaping (existing portfiles + pgrep hits)
//   sealAlive:       (nonce) => bool   (sealProcessAlive, pgrep)
//   withinGrace:     (nonce) => bool   KILL grace, clock = CONTAINER age (a booting container's seal isn't
//                                      pgrep-visible yet — Strike B).
//   withinReapGrace: (nonce) => bool   REAP grace, clock = SEAL age / portfile mtime, SIZED FOR A COLD LAUNCH
//                                      (Colima boot + image build = MINUTES: a fresh seal's container isn't
//                                      label-visible yet — Strike E). DISTINCT CLOCKS from withinGrace: keying
//                                      both on one timer cross-wires them — a shared seal-spawn clock starts
//                                      BEFORE container launch, so the kill grace would expire early and
//                                      false-kill a still-booting container (Strike B back open). A genuine
//                                      orphan's mtime is minutes-to-hours old; a resume's is seconds — a
//                                      generous reap grace never mis-classifies.
// returns { killContainers:[nonce…], reapSeals:[nonce…] }
export function reconcileSealDecision({ liveSealNonces, allSealNonces = [], sealAlive, withinGrace, withinReapGrace = () => false }) {
  const live = liveSealNonces instanceof Set ? liveSealNonces : new Set(liveSealNonces || [])
  const killContainers = []
  const reapSeals = []
  for (const nonce of live) {
    if (!sealAlive(nonce) && !withinGrace(nonce)) killContainers.push(nonce)   // zombie: container up, seal dead, past boot grace
  }
  for (const nonce of new Set(allSealNonces)) {
    if (!live.has(nonce) && sealAlive(nonce) && !withinReapGrace(nonce)) reapSeals.push(nonce)  // orphan: seal alive, no live container carries the nonce, PAST the reap grace
  }
  return { killContainers, reapSeals }
}

// The launcher's orchestration: ensure a live seal for this nonce BEFORE `docker run`, fail-closed. The
// action table is CORRECTED per Pierre — refuse-to-respawn is ONLY for `alive`:
//  - alive               → reuse it (idempotent relaunch / resume). "My seal, my secret, 200 = don't double-spawn."
//  - dead                → my seal is gone → clean + respawn on a FRESH free port.
//  - alive-wrong-secret  → ALSO my seal is gone. The secret is STABLE across resume (#44, adversary records
//                          never pruned), so my own live seal can NEVER 407 my own secret — a 407 is provably a
//                          FOREIGN process that grabbed my recycled port (stale portfile). Clean + respawn on a
//                          FRESH free port (the old port is owned by that foreign process). Refusing here would
//                          DEADLOCK resume whenever the port recycled — a #41-class bug in the resume path.
// The seal is spawned on a launcher-allocated FREE port; the freshness token makes a prior launch's stale
// portfile (same nonce) un-readable as "ready" (the stale-portfile-on-resume race). Bind-fail (port stolen
// between alloc + listen) → no matching-freshness portfile → timeout → { ok:false } → the caller does NOT
// launch the container (fail-closed). `secret` here is the derived EGRESS TOKEN, not the master.
export async function ensureSeal({ nonce, secret, allowlist, freshness, portBase, findPort, liveContainerForNonce, readyTimeoutMs = 8000, pollMs = 100 }) {
  const alloc = findPort || (() => findFreePort(Number(portBase) || 9440))
  const state = await sealAliveForNonce(nonce, secret)
  // Reuse ONLY if the seal is alive AND a live container still carries the nonce — an idempotent relaunch of a
  // RUNNING member (its container is up, don't disturb it). An alive seal with NO live container is a DOOMED
  // ORPHAN the reconcile is about to reap (Strike A, launch half): reusing it would ride the new container on a
  // corpse. `liveContainerForNonce` is injected (docker ps). FAIL-SAFE DEFAULT (Pierre): if it is NOT injected,
  // do NOT reuse — respawn fresh. A missing injection must fail toward the safe behavior (never ride a corpse),
  // not toward the very reuse-on-alive the gate exists to prevent. "The gate is on unless someone forgets" is
  // exactly the footgun this codebase keeps punishing — so a forgotten injection can only be over-safe.
  if (state === 'alive' && liveContainerForNonce && (await liveContainerForNonce(nonce))) {
    const pf = readSealPortfile(nonce); return { ok: true, already: true, port: pf.port, pid: pf.pid }
  }
  // Otherwise (dead / alive-wrong-secret / alive-but-orphan) → REAP-then-spawn: kill any prior instance of
  // THIS nonce FIRST, so one live seal per nonce ever exists and the nonce-keyed portfile never names two
  // instances (the #41 refuse/reap-before-respawn discipline — masterAliveForSock, applied to the seal).
  reapSealForNonce(nonce)
  const port = await alloc()
  const pid = spawnSeal({ nonce, secret, port, allowlist, freshness })
  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    const pf = readSealPortfile(nonce)
    if (pf && pf.freshness === String(freshness) && (await probeSeal(pf.port, secret)) === 'alive') {
      return { ok: true, port: pf.port, pid }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  // Fail-closed must also be CLEAN-closed (Pierre): spawnSeal is detached+unref'd, so a bind-timeout would
  // otherwise leak a half-spawned zombie sidecar (+ its stale portfile). Reap the corpse we couldn't confirm
  // BEFORE refusing — so every failed caged launch cleans up after itself instead of leaking a detached seal.
  reapSealForNonce(nonce, freshness)
  return { ok: false, error: `seal for nonce ${nonce} did not confirm bound within ${readyTimeoutMs}ms (fail-closed — the container is NOT launched, the unconfirmed seal reaped)` }
}

// --- standalone sidecar entry: `node seal.js <port> --auth <secret> --portfile <path> --freshness <tok> [--allow a,b]`
// Starts the SNI-pinning proxy with client-auth, then writes the readiness portfile AFTER listen() resolves —
// so the launcher's ensureSeal poll only sees "ready" once the port is genuinely bound (bind-fail → no
// portfile → the launcher fails closed). Runs detached; it is reaped by the daemon when its container dies.
if (process.argv[1] && process.argv[1].endsWith('seal.js') && process.argv[2]) {
  const argv = process.argv.slice(2)
  const port = Number(argv[0])
  const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  const auth = flag('--auth')
  const portfile = flag('--portfile')
  const freshness = flag('--freshness')
  const allow = flag('--allow')
  startSniProxy(port, { auth, ...(allow ? { allowlist: allow.split(',') } : {}) })
    .then((server) => {
      if (portfile) {
        const dir = dirname(portfile); mkdirSync(dir, { recursive: true })
        const tmp = `${portfile}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify({ port: server.address().port, pid: process.pid, freshness }))
        renameSync(tmp, portfile)
      }
    })
    .catch((e) => { console.error(`[seal] bind failed on :${port} — ${e.message}`); process.exit(1) })
}
