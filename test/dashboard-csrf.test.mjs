// 2b.1 — CSRF / same-origin defense for the browser-only dashboard HTTP surface. A page the user
// visits must not be able to drive the dashboard's state-changing POSTs against 127.0.0.1:<port>.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs'
import { join } from 'node:path'
import { startDashboard, rejectScriptTokens } from '../src/rooms-dashboard.js'
import { safeAssetPath, ASSET_CONTENT_TYPES, resolveTerritoryImage } from '../src/safe-path.js'   // #56: canonical shared impl (re-exported by rooms-dashboard.js too)

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

// #48c: the /api/asset content-type allowlist is the second half of the guard (the path guard + THIS map).
// It must mirror exactly what media.js emits (Gemini png/jpg, ElevenLabs mp3) and NEVER admit a
// script-bearing type — svg in particular is XSS surface if ever served with its real content-type.
test('#48c ASSET_CONTENT_TYPES: admits raster + mp3 only; never svg / html / source', () => {
  assert.equal(ASSET_CONTENT_TYPES['.mp3'], 'audio/mpeg', 'mp3 → audio/mpeg (the audio preview type)')
  assert.equal(ASSET_CONTENT_TYPES['.png'], 'image/png')
  assert.equal(ASSET_CONTENT_TYPES['.jpg'], 'image/jpeg')
  // every value is an image/* or audio/* type — nothing executable/markup
  for (const [ext, ct] of Object.entries(ASSET_CONTENT_TYPES)) {
    assert.ok(/^(image|audio)\//.test(ct), `${ext} maps to a non-script media type, got ${ct}`)
  }
  // the dangerous extensions are absent (no producer + script/markup surface)
  for (const bad of ['.svg', '.html', '.htm', '.js', '.wav', '.ogg', '.m4a', '.env', '.json']) {
    assert.equal(ASSET_CONTENT_TYPES[bad], undefined, `${bad} must NOT be served`)
  }
})

// #56: resolveTerritoryImage — the send_photo guard (untrusted agent → external service). DUAL containment
// (repo via safeAssetPath, THEN the member's territory sub-tree with realpath+trailing-sep rigor) + image-
// ext only. The threat is exfiltration, so a member must only reach IMAGES inside its OWN territory.
test('#56 resolveTerritoryImage: image inside the member territory resolves; sibling-prefix / cross-territory / non-image / traversal all reject', () => {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'mrc-terr-'))
  const repo = join(root, 'repo')
  for (const d of ['client', 'src', 'src-evil', 'b', 'a', 'assets']) fs.mkdirSync(join(repo, d), { recursive: true })
  fs.writeFileSync(join(repo, 'client', 'shot.png'), 'PNG')
  fs.writeFileSync(join(repo, 'src', 'ok.png'), 'PNG')
  fs.writeFileSync(join(repo, 'src-evil', 'leak.png'), 'LEAK')   // sibling dir sharing the 'src' prefix
  fs.writeFileSync(join(repo, 'b', 'secret.png'), 'B')           // another member's subtree
  fs.writeFileSync(join(repo, 'assets', 'cat.png'), 'PNG')
  fs.writeFileSync(join(repo, 'assets', 'chime.mp3'), 'MP3')     // an allowed /api/asset type, but NOT image
  fs.writeFileSync(join(repo, 'assets', 'notes.txt'), 'TXT')
  fs.writeFileSync(join(root, 'outside.png'), 'OUT')

  // ✓ image within the member's own territory (repo-relative path, the agent's real view)
  assert.equal(resolveTerritoryImage(repo, 'client', 'client/shot.png').file, fs.realpathSync(join(repo, 'client', 'shot.png')))
  // ✓ territory='.' → collapses to the repo check (a broad-territory relay member) — any repo image
  assert.equal(resolveTerritoryImage(repo, '.', 'assets/cat.png').file, fs.realpathSync(join(repo, 'assets', 'cat.png')))
  // ✗ SIBLING-PREFIX: src-evil/leak.png must NOT pass a `src` territory (the trailing-sep rigor)
  assert.ok(resolveTerritoryImage(repo, 'src', 'src-evil/leak.png').error, 'src-evil sibling rejected past src territory')
  // ✗ CROSS-TERRITORY: member with territory 'a' reaching member-b's subtree
  assert.ok(resolveTerritoryImage(repo, 'a', 'b/secret.png').error, 'cross-territory reach rejected')
  // ✗ NON-IMAGE: mp3 is an /api/asset content-type but not image/* → rejected for send_photo
  assert.ok(resolveTerritoryImage(repo, '.', 'assets/chime.mp3').error, 'mp3 rejected (image-only)')
  assert.ok(resolveTerritoryImage(repo, '.', 'assets/notes.txt').error, 'txt rejected')
  // ✗ traversal / absolute / a directory all reject (inherited from safeAssetPath)
  assert.ok(resolveTerritoryImage(repo, '.', '../outside.png').error, 'traversal rejected')
  assert.ok(resolveTerritoryImage(repo, '.', 'client').error, 'a directory is not a file')
  // ✗ an image that exists but is OUTSIDE the narrower territory (in repo, in a different subtree)
  assert.ok(resolveTerritoryImage(repo, 'client', 'assets/cat.png').error, 'repo-valid but outside client territory')
})

// #63-A: the inject-time guard that keeps the injected <script> block parser-proof. ASSERT (fail-loud),
// not a transform — throws on any </script / <script / <!-- (case-insensitive); the real module passes.
test('#63-A rejectScriptTokens: throws on script-tag/comment-open tokens; the real safe-md.js passes clean', () => {
  // clean inputs pass (returns the source, chainable) — tags safeMD actually emits
  assert.equal(rejectScriptTokens('const a = "<strong>ok</strong> <pre><code>x</code></pre>"'), 'const a = "<strong>ok</strong> <pre><code>x</code></pre>"')
  // each dangerous token throws (case-insensitive). `</scripture` THROWS too: the dead-simple substring
  // over-matches a benign token, which only fail-louds (forces a deliberate encode) — never corrupts.
  for (const bad of ['</script>', '</SCRIPT >', '</script/', '<script>', '<SCRIPT src=x>', 'x<!-- y', 'a</script', '<script', '</scripture>']) {
    assert.throws(() => rejectScriptTokens(`/* ${bad} */`), /must not contain/, `should throw on: ${bad}`)
  }
  // THE no-op-today property: the real shipped module contains none of the three tokens → passes.
  const realMod = fs.readFileSync(new URL('../src/safe-md.js', import.meta.url), 'utf8')
  assert.doesNotThrow(() => rejectScriptTokens(realMod), 'the shipped safe-md.js must inject cleanly')
})
