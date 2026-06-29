// #21 — restart honesty. The post-restart cluster's root cause was a SILENT stale daemon: `mrc rooms
// restart` spawned a new daemon on the same port, then checked only that *something* answered the
// control port. If the old daemon survived the stop, the new one EADDRINUSE-exited and the OLD one
// kept answering → restart falsely reported success while serving old code (so #14/#16/#19/#20 never
// went live). The fix verifies the *version* the control port reports, not mere liveness.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { probeVersion, waitUpVersion, stopDaemon, portFree, roomDaemonPidsOnPort } from '../src/commands/pair.js'

// A stub control server that answers the `status` frame with a given version (or malformed/none).
function stubDaemon(version, { malformed = false, silent = false } = {}) {
  const server = net.createServer((sock) => {
    sock.on('data', () => {
      if (silent) return
      sock.write(malformed ? 'not-json\n' : JSON.stringify({ ok: true, version }) + '\n')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

test('#21 probeVersion: returns the version the daemon reports', async () => {
  const d = await stubDaemon('newcode123')
  try { assert.equal(await probeVersion(d.port), 'newcode123') } finally { d.server.close() }
})

test('#21 probeVersion: null on a malformed reply, a silent port, or no server', async () => {
  const bad = await stubDaemon('x', { malformed: true })
  const mute = await stubDaemon('x', { silent: true })
  try {
    assert.equal(await probeVersion(bad.port), null, 'malformed → null')
    assert.equal(await probeVersion(mute.port), null, 'silent → null (times out)')
    // nothing listening on this port
    const free = await new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
    assert.equal(await probeVersion(free), null, 'no server → null')
  } finally { bad.server.close(); mute.server.close() }
})

test('#21 waitUpVersion: true when the FRESH version answers', async () => {
  const d = await stubDaemon('v2')
  try { assert.equal(await waitUpVersion(d.port, 'v2', 5), true) } finally { d.server.close() }
})

test('#21 waitUpVersion: false when only the OLD daemon is still answering (the stale-success bug)', async () => {
  // Old daemon survived a failed stop and still answers, but with the OLD version. A liveness-only
  // check would wrongly pass; the version check must reject it so the restart reports honest failure.
  const old = await stubDaemon('v1-old')
  try { assert.equal(await waitUpVersion(old.port, 'v2-new', 4), false) } finally { old.server.close() }
})

// ---- #45: authoritative restart self-kill (stale recorded pid → find-by-port SIGKILL; port-bindable confirm) ----
test('#45 portFree: false while a port is bound, true once released', async () => {
  const s = net.createServer()
  const port = await new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)))
  assert.equal(await portFree(port), false, 'bound → not free')
  await new Promise((r) => s.close(r))
  assert.equal(await portFree(port), true, 'released → free')
})

test('#45 stopDaemon: a STALE recorded pid → find-by-port SIGKILLs the REAL holder → port freed (true)', async () => {
  const killed = new Set(); const calls = []
  const ok = await stopDaemon({ port: 1, controlPort: 2, pid: 999 }, {
    kill: (pid, sig) => { calls.push([pid, sig]); killed.add(pid) },
    free: async () => killed.has(1234),     // freed ONLY once the real holder (1234) is killed (999 is stale)
    findPids: () => [1234],                 // lsof finds the real daemon the recorded pid missed
    sleep: () => Promise.resolve(), shutdown: () => Promise.resolve(),
  })
  assert.equal(ok, true, 'reports success only after the port is actually freed')
  assert.ok(calls.some(([p, s]) => p === 1234 && s === 'SIGKILL'), 'SIGKILLed the REAL port holder found by lsof, not just the stale recorded pid')
})

test('#45 stopDaemon: cannot find/kill the holder → returns FALSE (fail loud, no false success)', async () => {
  const ok = await stopDaemon({ port: 1, controlPort: 2, pid: 999 }, {
    kill: () => {}, free: async () => false, findPids: () => [], sleep: () => Promise.resolve(), shutdown: () => Promise.resolve(),
  })
  assert.equal(ok, false, 'never reports success while the port is still held (never serves stale code)')
})

test('#45 stopDaemon: graceful shutdown frees the port → no kill escalation', async () => {
  const calls = []; let freed = false
  const ok = await stopDaemon({ port: 1, controlPort: 2, pid: 999 }, {
    kill: (pid, sig) => calls.push([pid, sig]),
    free: async () => freed,
    findPids: () => { throw new Error('must not reach find-by-port on the happy path') },
    sleep: () => Promise.resolve(), shutdown: () => { freed = true; return Promise.resolve() },
  })
  assert.equal(ok, true)
  assert.equal(calls.length, 0, 'a responsive daemon needs no SIGTERM/SIGKILL')
})
