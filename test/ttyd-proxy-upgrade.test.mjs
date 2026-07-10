// Guard-4 — the WS-upgrade proxy GLUE. The decision layer (resolveTtydRequest et al.) is unit-tested in
// ttyd-proxy.test.mjs; this proves the glue's load-bearing property (Pierre): on ANY reject, connect is NEVER
// called and the client socket IS destroyed — a 404-after-a-connect-attempt is still a hanging attempt. connect
// is injected + SPIED (not just "404 returned"). The happy path connects to the resolved sock and forwards the
// upgrade line.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { proxyTtydUpgrade } from '../src/rooms-dashboard.js'

function mockSocket() { const s = new EventEmitter(); s.destroyed = false; s.destroy = () => { s.destroyed = true }; s.pipe = () => {}; return s }
function mockUpstream() { const u = new EventEmitter(); u.written = ''; u.write = (d) => { u.written += d }; u.destroy = () => {}; u.pipe = () => {}; return u }

test('proxyTtydUpgrade: a REJECT decision destroys the socket and NEVER calls connect', () => {
  let connectCalls = 0
  const sock = mockSocket()
  proxyTtydUpgrade({ url: '/ttyd/x/%00', method: 'GET', headers: {} }, sock, Buffer.alloc(0),
    { connect: () => { connectCalls++; return mockUpstream() }, decide: () => ({ reject: { code: 404, reason: 'unknown-member' } }) })
  assert.equal(connectCalls, 0, 'connect must NEVER be called on a rejected upgrade (SSRF/cross-origin/unknown)')
  assert.equal(sock.destroyed, true, 'the client socket is destroyed on reject')
})

test('proxyTtydUpgrade: a NON-/ttyd upgrade is destroyed, never connected (the dashboard has no other WS)', () => {
  let connectCalls = 0
  const sock = mockSocket()
  proxyTtydUpgrade({ url: '/api/events', method: 'GET', headers: {} }, sock, Buffer.alloc(0),
    { connect: () => { connectCalls++; return mockUpstream() }, decide: () => ({ sock: '/should-not-reach' }) })
  assert.equal(connectCalls, 0)
  assert.equal(sock.destroyed, true)
})

test('proxyTtydUpgrade: a malformed URL is destroyed, never connected', () => {
  let connectCalls = 0
  const sock = mockSocket()
  proxyTtydUpgrade({ url: 'ht tp://%', method: 'GET', headers: {} }, sock, Buffer.alloc(0),
    { connect: () => { connectCalls++; return mockUpstream() }, decide: () => ({ sock: '/x' }) })
  assert.equal(connectCalls, 0)
  assert.equal(sock.destroyed, true)
})

test('proxyTtydUpgrade: an OK decision connects to the RESOLVED sock and forwards the upgrade request line', async () => {
  let connectedTo = null
  const upstream = mockUpstream()
  const connect = (sock, cb) => { connectedTo = sock; setImmediate(cb); return upstream }
  const sock = mockSocket()
  proxyTtydUpgrade({ url: '/ttyd/shop/roland%2Fclaude/ws?x=1', method: 'GET', headers: { host: 'x', upgrade: 'websocket' } }, sock, Buffer.alloc(0),
    { connect, decide: () => ({ sock: '/socks/roland.sock', rest: 'ws' }) })
  await new Promise((res) => setImmediate(res))
  assert.equal(connectedTo, '/socks/roland.sock', 'connects to the sock the decision resolved (never a wire path)')
  assert.match(upstream.written, /^GET \/ws\?x=1 HTTP\/1\.1/, 'forwards the upgrade request line to ttyd, preserving the query')
  assert.equal(sock.destroyed, false, 'a valid upgrade is piped, not destroyed')
})

test('proxyTtydUpgrade: teardown destroys BOTH sockets when the client closes (no half-open leak)', async () => {
  const upstream = mockUpstream()
  const connect = (sock, cb) => { setImmediate(cb); return upstream }
  const sock = mockSocket()
  let upDestroyed = false; upstream.destroy = () => { upDestroyed = true }
  proxyTtydUpgrade({ url: '/ttyd/shop/x%2Fclaude/ws', method: 'GET', headers: {} }, sock, Buffer.alloc(0),
    { connect, decide: () => ({ sock: '/s', rest: 'ws' }) })
  await new Promise((res) => setImmediate(res))
  sock.emit('close')   // the browser closed the terminal
  assert.equal(upDestroyed, true, 'the upstream ttyd socket is destroyed too (both torn down)')
})
