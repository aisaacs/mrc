// Guard-4 — the ttyd-proxy SSRF resolver + anti-clickjack headers. The SSRF test is the load-bearing one: prove
// `<org>/<handle>` are treated as registry KEYS, so no traversal/absolute/NUL/proto can escape to an arbitrary
// unix socket (a path-join would proxy to /run/docker.sock = RCE).
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTtydTarget, ttydSecurityHeaders, ttydSockWithinDir, parseTtydPath, resolveTtydRequest } from '../src/ttyd-proxy.js'
import { mkdtempSync, rmSync, writeFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

const LAUNCHES = { shop: { members: { 'roland/claude': { ttydSock: '/tmp/mrc/roland.sock' }, 'ludivine/claude': { ttydSock: '/tmp/mrc/ludivine.sock' } } } }

test('resolveTtydTarget: a KNOWN live member resolves to its ttyd socket', () => {
  assert.equal(resolveTtydTarget('shop', 'roland/claude', LAUNCHES), '/tmp/mrc/roland.sock')
})

test('resolveTtydTarget: unknown org / unknown handle → null (404, never connect)', () => {
  assert.equal(resolveTtydTarget('nope', 'roland/claude', LAUNCHES), null)
  assert.equal(resolveTtydTarget('shop', 'ghost/claude', LAUNCHES), null)
})

test('SSRF — traversal / absolute / NUL in org|handle NEVER escapes to an arbitrary socket', () => {
  // These are the exact payloads that a path-join resolver would turn into /run/docker.sock etc. As KEYS they
  // simply don't exist in the registry → null. net.connect is never reached with an attacker path.
  assert.equal(resolveTtydTarget('..', '..', LAUNCHES), null)
  assert.equal(resolveTtydTarget('shop', '../../../run/docker.sock', LAUNCHES), null)
  assert.equal(resolveTtydTarget('../../run', 'docker.sock', LAUNCHES), null)
  assert.equal(resolveTtydTarget('shop', '/run/docker.sock', LAUNCHES), null)     // absolute path as a key → no match
  assert.equal(resolveTtydTarget('shop', 'roland/claude\0', LAUNCHES), null)      // NUL-injection → rejected
  assert.equal(resolveTtydTarget('shop\0', 'roland/claude', LAUNCHES), null)
})

test('SSRF — prototype-pollution keys (__proto__ / constructor) do NOT resolve', () => {
  // hasOwnProperty gating means a magic key can never walk the prototype to a truthy ttydSock.
  assert.equal(resolveTtydTarget('__proto__', 'roland/claude', LAUNCHES), null)
  assert.equal(resolveTtydTarget('shop', '__proto__', LAUNCHES), null)
  assert.equal(resolveTtydTarget('constructor', 'prototype', LAUNCHES), null)
})

test('resolveTtydTarget: a live member with NO ttydSock (port-only / mid-launch) → null', () => {
  assert.equal(resolveTtydTarget('shop', 'x/claude', { shop: { members: { 'x/claude': { ttydPort: 7681 } } } }), null)
  assert.equal(resolveTtydTarget('shop', 'roland/claude', null), null)
  assert.equal(resolveTtydTarget('shop', 'roland/claude', {}), null)
})

test('ttydSockWithinDir belt: a socket inside the dir passes; outside / non-existent / symlink-escape → false', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-td-')))
  try {
    const inside = join(dir, 'roland.sock'); writeFileSync(inside, '')
    assert.equal(ttydSockWithinDir(inside, dir), true)
    // the poisoned-registry case this belt exists for: a value pointing at the Docker socket resolves OUTSIDE the dir
    assert.equal(ttydSockWithinDir('/run/docker.sock', dir), false)
    assert.equal(ttydSockWithinDir(join(dir, 'nope.sock'), dir), false)   // not on disk → not connectable
    // a symlink inside the dir pointing OUT must be caught by realpath (not a textual prefix check)
    const escape = join(dir, 'escape.sock'); try { symlinkSync('/run/docker.sock', escape) } catch {}
    assert.equal(ttydSockWithinDir(escape, dir), false)
    assert.equal(ttydSockWithinDir(inside, sep), false)                    // a `/`-dir would make everything "within" → rejected
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ttydSecurityHeaders: frame-ancestors self + X-Frame-Options DENY + no-referrer (anti-clickjack)', () => {
  const h = ttydSecurityHeaders()
  assert.equal(h['content-security-policy'], "frame-ancestors 'self'")
  assert.equal(h['x-frame-options'], 'DENY')
  assert.equal(h['referrer-policy'], 'no-referrer')
})

test('parseTtydPath: split-on-raw-/ THEN decode-per-segment (a handle with an encoded / round-trips)', () => {
  // roland/claude → encoded as roland%2Fclaude → split keeps it ONE segment → decode → roland/claude
  assert.deepEqual(parseTtydPath('/ttyd/shop/roland%2Fclaude/xterm.js'), { org: 'shop', handle: 'roland/claude', rest: 'xterm.js' })
  assert.deepEqual(parseTtydPath('/ttyd/shop/roland%2Fclaude'), { org: 'shop', handle: 'roland/claude', rest: '' })
  assert.deepEqual(parseTtydPath('/ttyd/shop/roland%2Fclaude/ws'), { org: 'shop', handle: 'roland/claude', rest: 'ws' })
  assert.equal(parseTtydPath('/ttyd/'), null)
  assert.equal(parseTtydPath('/ttyd/shop'), null)         // no handle
  assert.equal(parseTtydPath('/api/state'), null)
  assert.equal(parseTtydPath('/ttyd/x/%ZZ'), null)        // malformed %-encoding → reject
})

// resolveTtydRequest — the shared gate→resolve→belt for both HTTP and the WS upgrade. Injected checks so it's pure.
const ORG = 'shop', HANDLE = 'roland/claude'
const DEPS = {
  launches: { shop: { members: { 'roland/claude': { ttydSock: '/socks/roland.sock' } } } },
  sockDir: '/socks',
  originIsSelf: (o) => o === 'http://127.0.0.1:8787',
  hostIsSelf: (h) => h === '127.0.0.1:8787',
  within: () => true,   // isolate the gate/resolve logic from realpath I/O (ttydSockWithinDir has its own test)
}
const reqFor = (url, headers = {}) => ({ url, headers: { host: '127.0.0.1:8787', ...headers } })

test('resolveTtydRequest: same-origin, known member → { sock } (the happy path, before any connect)', () => {
  const r = resolveTtydRequest(reqFor(`/ttyd/${ORG}/${encodeURIComponent(HANDLE)}/ws`, { origin: 'http://127.0.0.1:8787' }), DEPS)
  assert.equal(r.sock, '/socks/roland.sock'); assert.equal(r.rest, 'ws')
})

test('resolveTtydRequest: cross-origin → 403 reject (never resolves/connects)', () => {
  const r = resolveTtydRequest(reqFor(`/ttyd/${ORG}/${encodeURIComponent(HANDLE)}/ws`, { origin: 'http://evil.example' }), DEPS)
  assert.equal(r.sock, undefined); assert.equal(r.reject.code, 403); assert.match(r.reject.reason, /cross-origin/)
})

test('resolveTtydRequest: unexpected Host (DNS-rebind) → 403', () => {
  const r = resolveTtydRequest(reqFor(`/ttyd/${ORG}/${encodeURIComponent(HANDLE)}/ws`, { host: 'evil.example', origin: 'http://127.0.0.1:8787' }), DEPS)
  assert.equal(r.reject.code, 403); assert.match(r.reject.reason, /host/)
})

test('resolveTtydRequest: MISSING Origin passes the origin check (deliberate host-local posture) if Host is self', () => {
  const r = resolveTtydRequest(reqFor(`/ttyd/${ORG}/${encodeURIComponent(HANDLE)}/ws`), DEPS)   // no origin header
  assert.equal(r.sock, '/socks/roland.sock')
})

test('resolveTtydRequest SSRF: decode-before-check — %00 and %2e%2e%2f resolve to null (404), never a sock', () => {
  const nul = resolveTtydRequest(reqFor(`/ttyd/${ORG}/%00`, { origin: 'http://127.0.0.1:8787' }), DEPS)
  assert.equal(nul.sock, undefined); assert.equal(nul.reject.code, 404)
  const trav = resolveTtydRequest(reqFor(`/ttyd/${ORG}/%2e%2e%2f%2e%2e%2frun%2fdocker.sock`, { origin: 'http://127.0.0.1:8787' }), DEPS)
  assert.equal(trav.sock, undefined); assert.equal(trav.reject.code, 404)
})

test('resolveTtydRequest: an unknown member → 404 (destroy at the caller, never connect null)', () => {
  const r = resolveTtydRequest(reqFor(`/ttyd/${ORG}/${encodeURIComponent('ghost/claude')}/ws`, { origin: 'http://127.0.0.1:8787' }), DEPS)
  assert.equal(r.sock, undefined); assert.equal(r.reject.code, 404)
})

test('resolveTtydRequest: sock resolves but is OUTSIDE the sockDir → 404 (the within-dir belt, before connect)', () => {
  const r = resolveTtydRequest(reqFor(`/ttyd/${ORG}/${encodeURIComponent(HANDLE)}/ws`, { origin: 'http://127.0.0.1:8787' }), { ...DEPS, within: () => false })
  assert.equal(r.sock, undefined); assert.equal(r.reject.code, 404); assert.match(r.reject.reason, /outside/)
})
