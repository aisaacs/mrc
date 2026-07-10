// Guard-4 — the ttyd-proxy SSRF resolver + anti-clickjack headers. The SSRF test is the load-bearing one: prove
// `<org>/<handle>` are treated as registry KEYS, so no traversal/absolute/NUL/proto can escape to an arbitrary
// unix socket (a path-join would proxy to /run/docker.sock = RCE).
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveTtydTarget, ttydSecurityHeaders, ttydSockWithinDir } from '../src/ttyd-proxy.js'
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
