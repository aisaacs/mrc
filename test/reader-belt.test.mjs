// Guard-3 reader belt — the SINGLE-BUFFER proof (Pierre). The belt must be `catch { sock.destroy(); return }`,
// NOT a bare `catch { sock.destroy() }`: destroy() does not synchronously halt the current on('data') callback,
// so without the `return` the synchronous while-loop keeps slicing the NEXT line (the smuggled control frame,
// already in `buf` from a single TCP segment), JSON.parse succeeds, and the action EXECUTES before destroy takes
// effect. A test that only asserts "socket closed" passes with the vulnerable bare-destroy; this asserts the
// SIDE EFFECT did not fire from one combined buffer — the only test that proves the `return` is load-bearing.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import { startRoomDaemon as _startRoomDaemon } from '../src/proxies/room-daemon.js'
import { findFreePort } from '../src/ports.js'

const _live = new Set()
function startRoomDaemon(o) { const d = _startRoomDaemon(o); if (d) _live.add(d); return d }   // teardown discipline (macOS exit-hang)
afterEach(() => { for (const d of _live) { try { d.stop?.() } catch {} } _live.clear() })

process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-belt-`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function controlCall(port, frame) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.write(JSON.stringify(frame) + '\n'))
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { resolve(JSON.parse(buf.slice(0, i))) } catch (e) { reject(e) } c.end() } })
    c.on('error', reject)
    setTimeout(() => reject(new Error('control timeout')), 1500)
  })
}

test('reader belt: a single-buffer HTTP preamble + smuggled defineOrg body does NOT execute the action', async () => {
  const port = await findFreePort(19500)
  const controlPort = await findFreePort(port + 1)
  startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9 })
  await sleep(200)   // let it bind

  // The exact cross-protocol attack a browser no-cors text/plain POST produces: ONE TCP segment carrying the HTTP
  // request-line + headers + the smuggled control frame as the body.
  const attack = 'POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: text/plain\r\n\r\n' +
                 '{"action":"defineOrg","def":{"org":"victimorg","repo":"/victim","members":[],"rooms":[]}}\n'
  await new Promise((res) => {
    const c = net.connect(controlPort, '127.0.0.1', () => { c.write(attack); c.end(); res() })
    c.on('error', () => res())
  })
  await sleep(250)   // give a (vulnerable) handler ample time to have fired

  // The daemon is unharmed, AND — the load-bearing assertion — the smuggled defineOrg did NOT fire: victimorg is undefined.
  const st = await controlCall(controlPort, { action: 'status' })
  assert.equal(st.ok, true, 'daemon healthy after the attack (belt closed the offending socket only)')
  const gr = await controlCall(controlPort, { action: 'getroster', org: 'victimorg' })
  assert.equal(gr.roster, null, 'the smuggled defineOrg must NOT have executed — victimorg must be undefined')
})

test('reader belt: a legit bare-JSON control frame is UNAFFECTED (no HTTP preamble → line 1 parses)', async () => {
  const port = await findFreePort(19520)
  const controlPort = await findFreePort(port + 1)
  startRoomDaemon({ port, controlPort, notifyPort: 0, version: 'test', idleMs: 9e9, tickMs: 9e9 })
  await sleep(200)
  const st = await controlCall(controlPort, { action: 'status' })   // a normal client sends bare JSON first
  assert.equal(st.ok, true, 'legit clients (bare-JSON-first, no preamble) still work — the belt only drops non-JSON line 1')
})
