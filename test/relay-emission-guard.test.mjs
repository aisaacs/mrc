// t27 Pierre trap-A/(ii): send() must be the ENFORCED sole emission point for a reliable frame. A reliable frame
// (deliver/directive/warning/catchup_request) that is written straight to a socket — instead of going through
// send() → outbox.enqueue → stamp(epoch,seq)+buffer — is UNBUFFERED: it can't be redelivered on a flap, which is
// the exact silent-loss hole this whole change closes. A future author adding such a raw write would reintroduce
// the bug with a green suite (send()'s protection is invisible at the bypass site). This makes it a RED build.
//
// The guard earns trust only if it goes red on a PLANTED bypass (the load-gate discipline: prove by running, not
// by reasoning), so the test asserts BOTH directions: the detector fires on a planted violation, and the real
// daemon source is clean.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const daemonSrc = readFileSync(join(here, '..', 'src', 'proxies', 'room-daemon.js'), 'utf8')

// A reliable-typed object literal written directly to a socket, bypassing send()/outbox. send() writes the
// stamped `out` variable and flushOutbox writes the `fr` variable from outbox.list() — neither is an INLINE
// reliable-typed literal — so this pattern matches only a genuine bypass.
const BYPASS = /\.write\(\s*JSON\.stringify\(\s*\{\s*type:\s*['"](deliver|directive|warning|catchup_request)['"]/

test('detector fires on a PLANTED reliable-frame bypass (proven by running, not reasoning)', () => {
  const planted = "sock.write(JSON.stringify({ type: 'deliver', text: 'x' }) + '\\n')"
  assert.ok(BYPASS.test(planted), 'the detector must catch an inline reliable-typed raw socket write')
  // and it must NOT trip on a legitimate ephemeral raw write (the pong / ack / notice-reject writes)
  assert.ok(!BYPASS.test("sock.write(JSON.stringify({ type: 'pong', version, epoch: bootEpoch }) + '\\n')"))
})

test('room-daemon.js emits every reliable frame through send() — no raw reliable-typed write', () => {
  const hits = daemonSrc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => BYPASS.test(l))
  assert.equal(hits.length, 0, hits.length ? `reliable frame bypasses send() at line(s): ${hits.map(([n]) => n).join(', ')}` : '')
})
