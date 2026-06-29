// 2b.1 — CSRF / same-origin defense for the browser-only dashboard HTTP surface. A page the user
// visits must not be able to drive the dashboard's state-changing POSTs against 127.0.0.1:<port>.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import { join } from 'node:path'
import { startDashboard, safeAssetPath } from '../src/rooms-dashboard.js'

// A throwaway HOME so listRooms/etc. never touch the real store.
process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-dash-`)

function request(port, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''
      res.on('data', (d) => { data += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body != null) req.write(body)
    req.end()
  })
}

test('dashboard CSRF: token + Origin/Host gate on POST; reads open; never emits CORS', async () => {
  const { server, port } = await startDashboard({ port: 18900 })
  try {
    // The served page carries the per-daemon token in a meta tag; the SPA reads it.
    const page = await request(port, { path: '/' })
    assert.equal(page.status, 200)
    const token = (page.body.match(/<meta name="mrc-token" content="([^"]+)">/) || [])[1]
    assert.ok(token && token.length >= 32, 'token embedded in served HTML')
    assert.equal(page.headers['access-control-allow-origin'], undefined, 'no ACAO on the HTML response')

    const jsonBody = JSON.stringify({ roster: { org: 'x', teams: [{ name: 't', members: [{ role: 'architect', backend: 'claude', lead: true }] }] } })
    const post = (headers) => request(port, { method: 'POST', path: '/api/team-preview', headers: { 'content-type': 'application/json', host: `127.0.0.1:${port}`, ...headers }, body: jsonBody })

    // Correct token + same host → processed (200). team-preview is pure, so no daemon is needed.
    const ok = await post({ 'x-mrc-token': token })
    assert.equal(ok.status, 200, 'valid token → 200')
    assert.equal(ok.headers['access-control-allow-origin'], undefined, 'no ACAO on the API response')

    // Missing token → 403.
    assert.equal((await post({})).status, 403, 'no token → 403')
    // Wrong token → 403.
    assert.equal((await post({ 'x-mrc-token': 'deadbeef' })).status, 403, 'wrong token → 403')
    // Cross-origin (even WITH the token, which a real cross-origin page could never read) → 403.
    assert.equal((await post({ 'x-mrc-token': token, origin: 'http://evil.example' })).status, 403, 'foreign Origin → 403')
    // Spoofed Host (DNS-rebinding) → 403.
    assert.equal((await post({ 'x-mrc-token': token, host: 'evil.example' })).status, 403, 'foreign Host → 403')

    // Reads (GET) need no token and never carry CORS.
    const state = await request(port, { path: '/api/state' })
    assert.equal(state.status, 200, 'GET read → 200 without a token')
    assert.equal(state.headers['access-control-allow-origin'], undefined, 'no ACAO on a read')

    // A state-changing path requested as GET is NOT handled as a mutation (falls through to 404).
    const getMutation = await request(port, { path: '/api/team-preview' })
    assert.equal(getMutation.status, 404, 'mutating path via GET is not a handled mutation')
  } finally {
    server.close()
  }
})

test('dashboard CSRF (#20): token persists across a restart and is stored 0600', async () => {
  // A fresh HOME so this test owns the token file.
  const home = fs.mkdtempSync(`${os.tmpdir()}/mrc-dash20-`)
  const prev = process.env.HOME
  process.env.HOME = home
  const tokenOf = (body) => (body.match(/<meta name="mrc-token" content="([0-9a-f]{64})">/) || [])[1]
  try {
    const d1 = await startDashboard({ port: 18920 })
    const t1 = tokenOf((await request(d1.port, { path: '/' })).body)
    assert.ok(t1, 'first boot embeds a 64-hex token')
    await new Promise((r) => d1.server.close(r))   // simulate a daemon restart (fully torn down)

    // A restarted daemon may bind any free port; the token reuse depends only on HOME, not the port.
    const d2 = await startDashboard({ port: 18930 })
    try {
      const t2 = tokenOf((await request(d2.port, { path: '/' })).body)
      // The whole point of #20: an already-open tab holding t1 keeps validating after a restart.
      assert.equal(t2, t1, 'token is reused across restarts (open tab survives, no stale-403)')
      const mode = fs.statSync(join(home, '.local', 'share', 'mrc', 'dashboard-token')).mode & 0o777
      assert.equal(mode, 0o600, 'persisted token file is 0600')
    } finally {
      d2.server.close()
    }
  } finally {
    process.env.HOME = prev
  }
})

// #48b: /api/asset path-traversal guard (the highest-risk endpoint — serves file bytes).
test('#48b safeAssetPath: serves an in-repo image; rejects traversal / absolute / null-byte / symlink-escape / sibling-prefix', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'mrc-asset-'))
  const repo = join(root, 'repo'); fs.mkdirSync(join(repo, 'assets'), { recursive: true })
  fs.writeFileSync(join(repo, 'assets', 'cat.png'), 'PNGDATA')
  fs.writeFileSync(join(repo, '.env'), 'SECRET=1')
  // a SIBLING dir whose name shares the repo's prefix (the trailing-sep check must reject it)
  const sibling = join(root, 'repo-secret'); fs.mkdirSync(sibling, { recursive: true }); fs.writeFileSync(join(sibling, 'leak.png'), 'LEAK')
  const outside = join(root, 'outside.png'); fs.writeFileSync(outside, 'OUTSIDE')

  // ✓ a real image inside the repo resolves (to its realpath)
  assert.equal(safeAssetPath(repo, 'assets/cat.png'), fs.realpathSync(join(repo, 'assets', 'cat.png')))
  // ✗ `..` traversal (even toward an existing file) — rejected at the string guard
  assert.equal(safeAssetPath(repo, '../outside.png'), null)
  assert.equal(safeAssetPath(repo, 'assets/../../outside.png'), null)
  assert.equal(safeAssetPath(repo, 'assets/../../repo-secret/leak.png'), null)
  // ✗ absolute path / null byte
  assert.equal(safeAssetPath(repo, outside), null)
  assert.equal(safeAssetPath(repo, '/etc/passwd'), null)
  assert.equal(safeAssetPath(repo, 'assets/cat.png\0.png'), null)
  // ✗ symlink that escapes the repo (realpath-on-final-file defeats it)
  try {
    fs.symlinkSync(outside, join(repo, 'assets', 'escape.png'))
    assert.equal(safeAssetPath(repo, 'assets/escape.png'), null, 'a symlink pointing outside the repo is rejected')
  } catch { /* symlink may be unavailable in the sandbox — the realpath containment still holds */ }
  // ✗ a DIRECTORY (even an in-repo one) → null — the primitive's contract is "safe regular-FILE or null"
  assert.equal(safeAssetPath(repo, 'assets'), null)
  assert.equal(safeAssetPath(repo, '.'), null)
  // ✗ missing file → null (no leak of existence); ✗ empty/garbage input
  assert.equal(safeAssetPath(repo, 'assets/nope.png'), null)
  assert.equal(safeAssetPath(repo, ''), null)
  assert.equal(safeAssetPath('', 'assets/cat.png'), null)
})
