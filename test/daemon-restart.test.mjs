// #21 — restart honesty. The post-restart cluster's root cause was a SILENT stale daemon: `mrc rooms
// restart` spawned a new daemon on the same port, then checked only that *something* answered the
// control port. If the old daemon survived the stop, the new one EADDRINUSE-exited and the OLD one
// kept answering → restart falsely reported success while serving old code (so #14/#16/#19/#20 never
// went live). The fix verifies the *version* the control port reports, not mere liveness.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { probeVersion, waitUpVersion } from '../src/commands/pair.js'

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
