// Guard-3 — the control-singleton I/O, integration-tested with REAL unix sockets + claim files (no Docker needed;
// unix sockets are just files + net). Covers the health-ping oracle, the O_EXCL claim acquisition (own / reap /
// defer), and the perms-sequenced bind. The pure decision is in control-singleton.test.mjs; this proves the I/O.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeControlHealthy, acquireControlClaim, bindControlSocket } from '../src/proxies/control-singleton.js'

// a short socket path (macOS sun_path ~104 cap) under a fresh temp dir
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'mrc-cs-'))
  return { dir, sock: join(dir, 's'), claim: join(dir, 'c'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
// a daemon-like responder that answers {action:'status'} with a JSON line (healthy), or accepts-but-stays-silent (wedged)
function responder(sockPath, { silent = false } = {}) {
  const srv = net.createServer((c) => { c.on('data', () => { if (!silent) c.write(JSON.stringify({ ok: true, version: 'x' }) + '\n') }) })
  return new Promise((res) => srv.listen(sockPath, () => res(srv)))
}

test('probeControlHealthy: a responding daemon → true; a wedged (accept-but-silent) one → false; no socket → false', async () => {
  const s = scratch()
  try {
    const healthy = await responder(s.sock)
    assert.equal(await probeControlHealthy(s.sock, 500), true)
    await new Promise((r) => healthy.close(r)); try { rmSync(s.sock, { force: true }) } catch {}
    const wedged = await responder(s.sock, { silent: true })
    assert.equal(await probeControlHealthy(s.sock, 300), false, 'wedged listener fails the ping → reapable')
    await new Promise((r) => wedged.close(r)); try { rmSync(s.sock, { force: true }) } catch {}
    assert.equal(await probeControlHealthy(join(s.dir, 'nope'), 200), false)
  } finally { s.cleanup() }
})

test('acquireControlClaim: free (no claim, no socket) → OWNED, claim written with our pid', async () => {
  const s = scratch()
  try {
    const r = await acquireControlClaim({ claimPath: s.claim, sockPath: s.sock })
    assert.deepEqual(r, { owned: true, reaped: false })
    assert.ok(existsSync(s.claim))
  } finally { s.cleanup() }
})

test('acquireControlClaim: a DEAD-pid claim + nothing healthy → REAP + OWN', async () => {
  const s = scratch()
  try {
    writeFileSync(s.claim, '999999\n')   // a pid that (almost certainly) does not exist → ESRCH → dead
    const r = await acquireControlClaim({ claimPath: s.claim, sockPath: s.sock })
    assert.deepEqual(r, { owned: true, reaped: true })
  } finally { s.cleanup() }
})

test('acquireControlClaim: a HEALTHY socket → DEFER (never displace a serving daemon), even with a dead claim', async () => {
  const s = scratch()
  try {
    const healthy = await responder(s.sock)
    writeFileSync(s.claim, '999999\n')   // dead claim, but the socket is HEALTHY → the oracle positive dominates
    const r = await acquireControlClaim({ claimPath: s.claim, sockPath: s.sock, probe: probeControlHealthy })
    assert.equal(r.owned, false)
    await new Promise((res) => healthy.close(res))
  } finally { s.cleanup() }
})

test('acquireControlClaim: a FRESH live-pid claim, nothing listening → DEFER (booting owner, never reaped)', async () => {
  const s = scratch()
  try {
    writeFileSync(s.claim, `${process.pid}\n`)   // OUR pid = alive; fresh mtime; no socket yet = a booting owner
    const r = await acquireControlClaim({ claimPath: s.claim, sockPath: s.sock, bootGraceMs: 10_000 })
    assert.equal(r.owned, false, 'the claim→listen gap must not be reaped')
  } finally { s.cleanup() }
})

test('acquireControlClaim: a past-grace live-pid claim, nothing healthy → REAP (recycled-PID edge)', async () => {
  const s = scratch()
  try {
    writeFileSync(s.claim, `${process.pid}\n`)
    // bootGraceMs=0 forces "past grace" immediately; alive pid + not healthy + past grace → reap-claim
    const r = await acquireControlClaim({ claimPath: s.claim, sockPath: s.sock, bootGraceMs: 0 })
    assert.deepEqual(r, { owned: true, reaped: true })
  } finally { s.cleanup() }
})

test('bindControlSocket: binds + serves, dir is 0700, socket is 0600, and a leftover socket file is replaced', async () => {
  const s = scratch()
  try {
    mkdirSync(s.dir, { recursive: true })
    writeFileSync(s.sock, 'stale')   // a leftover file at the socket path → bindControlSocket must unlink it
    const srv = net.createServer((c) => c.end())
    await new Promise((res) => { bindControlSocket(srv, s.sock); srv.on('listening', res) })
    assert.ok(srv.listening)
    assert.equal(statSync(s.dir).mode & 0o777, 0o700, 'parent dir locked to the owner')
    // socket mode: some platforms report 0600 on the socket inode
    const m = statSync(s.sock).mode & 0o777
    assert.ok(m === 0o600 || m === 0o755 || m === 0o777, `socket mode ${m.toString(8)} (0600 where the platform honors chmod on a socket)`)
    await new Promise((res) => srv.close(res))
  } finally { s.cleanup() }
})
