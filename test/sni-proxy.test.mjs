// Test for src/proxies/sni-proxy.js — the SNI-pinning egress proxy that seals the A/#40
// Cloudflare SNI-ride. Two layers: (1) unit-test the ClientHello SNI parser against crafted
// fixtures, (2) drive the REAL proxy over a loopback socket with a fake upstream (via the
// dialUpstream seam) to prove it tunnels an allowlisted SNI, drops a foreign one, and — the
// whole point — drops a foreign SNI SMUGGLED inside `CONNECT api.anthropic.com`.
//
//   run:  node test/sni-proxy.test.mjs      (exit 0 = all pass)
import { createServer, connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const { parseClientHelloSNI, startSniProxy } = await import(join(here, '../src/proxies/sni-proxy.js'))

let pass = 0, fail = 0
const ck = (n, c) => { if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + n) } else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + n) } }
const delay = ms => new Promise(r => setTimeout(r, ms))
const once = (em, ev) => new Promise(res => em.once(ev, res))

// Build a TLS ClientHello record carrying `sni`, with knobs to forge the adversarial cases the strict parser
// must reject: omitSni, a leading dummy ext, >1 server_name ext (sniExtCount), >1 host_name (hostCount), raw
// host bytes (hostBytes, for non-LDH), and junk after the extensions block not covered by extLen (extTrailing).
function buildClientHello(sni, opts = {}) {
  const { record = 0x16, hsType = 0x01, omitSni = false, leadExt = false,
          sniExtCount = 1, hostCount = 1, hostBytes = null, extTrailing = null, echExt = false } = opts
  const u16 = n => Buffer.from([(n >> 8) & 0xff, n & 0xff])
  const sniExt = () => {
    const host = hostBytes || Buffer.from(sni, 'latin1')
    const entry = Buffer.concat([Buffer.from([0x00]), u16(host.length), host])   // name_type host_name + name
    const entries = []
    for (let i = 0; i < hostCount; i++) entries.push(entry)
    const listBody = Buffer.concat(entries)
    return Buffer.concat([u16(0x0000), u16(2 + listBody.length), u16(listBody.length), listBody])  // ext: type + len + list
  }
  const exts = []
  if (leadExt) exts.push(Buffer.concat([u16(0x0017), u16(0)]))     // a dummy ext BEFORE sni → parser must skip it
  if (echExt) exts.push(Buffer.concat([u16(0xfe0d), u16(4), Buffer.from([0, 1, 2, 3])]))  // encrypted_client_hello (canary)
  if (!omitSni) for (let i = 0; i < sniExtCount; i++) exts.push(sniExt())
  const extBlock = Buffer.concat(exts)
  const fixed = Buffer.concat([
    Buffer.from([0x03, 0x03]),                       // client_version (TLS 1.2)
    Buffer.alloc(32, 0x11),                          // random
    Buffer.from([0x00]),                             // session_id (len 0)
    u16(2), Buffer.from([0x13, 0x01]),               // cipher_suites (len 2)
    Buffer.from([0x01, 0x00]),                       // compression_methods (len 1, null)
  ])
  // extLen covers ONLY extBlock; extTrailing (if any) is junk after it inside the handshake → non-canonical.
  let body = Buffer.concat([fixed, u16(extBlock.length), extBlock])
  if (extTrailing) body = Buffer.concat([body, extTrailing])
  const hs = Buffer.concat([Buffer.from([hsType, (body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body])
  return Buffer.concat([Buffer.from([record, 0x03, 0x01]), u16(hs.length), hs])
}

// ── 1. Parser unit tests ───────────────────────────────────────────────────
ck('parse: extracts api.anthropic.com', parseClientHelloSNI(buildClientHello('api.anthropic.com')).sni === 'api.anthropic.com')
ck('parse: extracts example.com', parseClientHelloSNI(buildClientHello('example.com')).sni === 'example.com')
ck('parse: skips a leading extension', parseClientHelloSNI(buildClientHello('api.anthropic.com', { leadExt: true })).sni === 'api.anthropic.com')
ck('parse: no SNI extension → null', parseClientHelloSNI(buildClientHello('x', { omitSni: true })).sni === null)
ck('parse: non-handshake record (0x17) → null', parseClientHelloSNI(buildClientHello('x', { record: 0x17 })).sni === null)
ck('parse: not a ClientHello (hs 0x02) → null', parseClientHelloSNI(buildClientHello('x', { hsType: 0x02 })).sni === null)
ck('parse: < 5 bytes → need more', parseClientHelloSNI(Buffer.from([0x16, 0x03])).need === true)
const full = buildClientHello('api.anthropic.com')
ck('parse: partial record → need more', parseClientHelloSNI(full.slice(0, full.length - 5)).need === true)
ck('parse: reassembled prefix-by-prefix resolves', parseClientHelloSNI(full).sni === 'api.anthropic.com')
ck('parse: oversized record length → null', parseClientHelloSNI(Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff]), Buffer.alloc(20)])).sni === null)

// ── 1b. Adversarial parser fixtures (Pierre Findings 1/2/4) — every non-canonical hello MUST drop, so our
//        parse can't disagree with the upstream BoringSSL parse (the A/#40 differential). ────────────────
ck('parse: duplicate server_name extension → null', parseClientHelloSNI(buildClientHello('api.anthropic.com', { sniExtCount: 2 })).sni === null)
ck('parse: duplicate host_name entry → null', parseClientHelloSNI(buildClientHello('api.anthropic.com', { hostCount: 2 })).sni === null)
ck('parse: server_name ext with zero host_names → null', parseClientHelloSNI(buildClientHello('api.anthropic.com', { hostCount: 0 })).sni === null)
ck('parse: trailing bytes after the extensions block → null', parseClientHelloSNI(buildClientHello('api.anthropic.com', { extTrailing: Buffer.from([0xab, 0xcd]) })).sni === null)
ck('parse: non-LDH SNI byte (0xE1 must NOT fold to "a") → null',
  parseClientHelloSNI(buildClientHello('', { hostBytes: Buffer.concat([Buffer.from([0xe1]), Buffer.from('pi.anthropic.com', 'latin1')]) })).sni === null)
const _frag = buildClientHello('api.anthropic.com'); _frag.writeUInt16BE(_frag.readUInt16BE(3) - 1, 3)
ck('parse: handshake longer than its record (fragmented/over-claim) → null', parseClientHelloSNI(_frag).sni === null)
const _tail = Buffer.concat([buildClientHello('api.anthropic.com'), Buffer.from([0xab])]); _tail.writeUInt16BE(_tail.readUInt16BE(3) + 1, 3)
ck('parse: bytes trailing the handshake inside the record → null', parseClientHelloSNI(_tail).sni === null)
// and the canonical hello still parses (no false negative from the new strictness)
ck('parse: canonical hello with a leading benign ext still resolves', parseClientHelloSNI(buildClientHello('api.anthropic.com', { leadExt: true })).sni === 'api.anthropic.com')
// ECH canary (Pierre F-round-4): a 0xfe0d extension is flagged so the day the agent negotiates ECH is observable
ck('parse: ECH ext (0xfe0d) → ech=true, SNI still extracted', (() => { const r = parseClientHelloSNI(buildClientHello('api.anthropic.com', { echExt: true })); return r.ech === true && r.sni === 'api.anthropic.com' })())
ck('parse: no ECH ext → ech falsy', !parseClientHelloSNI(buildClientHello('api.anthropic.com')).ech)

// ── 2. End-to-end over a real socket ────────────────────────────────────────
const upstreamGot = []
const fakeUpstream = createServer(sock => { sock.on('data', d => { upstreamGot.push(d); sock.write(d) }); sock.on('error', () => {}) })   // echo
await new Promise(r => fakeUpstream.listen(0, '127.0.0.1', r))
const upPort = fakeUpstream.address().port

const dialed = []
const proxy = await startSniProxy(0, {
  allowlist: ['allowed.test', 'api.anthropic.com'],
  dialUpstream: sni => { dialed.push(sni); return connect({ host: '127.0.0.1', port: upPort }) },
})
const port = proxy.address().port
const cnt = sni => dialed.filter(s => s === sni).length

// Drive one CONNECT, return { c, status } after the proxy's HTTP reply; caller then writes the ClientHello.
async function open(connectLine) {
  const c = connect({ host: '127.0.0.1', port }); await once(c, 'connect')
  let buf = Buffer.alloc(0), closed = false
  c.on('data', d => { buf = Buffer.concat([buf, d]) }); c.on('close', () => { closed = true }); c.on('error', () => {})
  c.write(connectLine); await delay(60)
  const status = buf.toString('ascii', 0, 12)
  return { c, status, recv: () => buf, reset: () => { buf = Buffer.alloc(0) }, closed: () => closed }
}

// A — allowlisted SNI tunnels bytes both ways
{
  const s = await open('CONNECT allowed.test:443 HTTP/1.1\r\n\r\n')
  ck('e2e allow: 200 Connection established', s.status.startsWith('HTTP/1.1 200'))
  s.reset()
  const hello = buildClientHello('allowed.test')
  s.c.write(hello); s.c.write(Buffer.from('PING')); await delay(120)
  ck('e2e allow: dialed the validated SNI host', cnt('allowed.test') === 1)
  ck('e2e allow: ClientHello + payload tunneled (echo round-trips)', s.recv().length === hello.length + 4 && s.recv().slice(-4).toString() === 'PING')
  s.c.destroy()
}

// B — foreign SNI via a foreign CONNECT host is dropped, nothing dialed, no bytes flow
{
  const s = await open('CONNECT foreign.test:443 HTTP/1.1\r\n\r\n')
  s.reset()
  s.c.write(buildClientHello('foreign.test')); s.c.write(Buffer.from('SECRET-EXFIL')); await delay(120)
  ck('e2e drop: foreign SNI never dialed', cnt('foreign.test') === 0)
  ck('e2e drop: connection closed with zero tunnel bytes', s.closed() && s.recv().length === 0)
}

// C — THE SMUGGLE (A/#40): allowlisted CONNECT host, foreign SNI inside the tunnel → dropped
{
  const s = await open('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n')
  ck('e2e smuggle: CONNECT to the allowed host still gets 200', s.status.startsWith('HTTP/1.1 200'))
  s.reset()
  s.c.write(buildClientHello('evil.example')); s.c.write(Buffer.from('SECRET-EXFIL')); await delay(120)
  ck('e2e smuggle: in-tunnel foreign SNI dropped (neither host dialed)', cnt('evil.example') === 0 && cnt('api.anthropic.com') === 0)
  ck('e2e smuggle: connection closed, nothing exfiltrated', s.closed())
}

// C2 — a NON-CANONICAL hello to the ALLOWED host is dropped too (strict-parse reject, sni===null) — proves the
// drop isn't only for foreign-NAMED hellos. (If this ever fired on a real agent's hello, the parser's over-
// strict; that's the fail-closed brick Pierre flagged — here we assert the malformed case is refused.)
{
  const s = await open('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n')
  s.reset()
  const frag = buildClientHello('api.anthropic.com'); frag.writeUInt16BE(frag.readUInt16BE(3) - 1, 3)  // over-claiming handshake
  s.c.write(frag); s.c.write(Buffer.from('SECRET')); await delay(120)
  ck('e2e strict: non-canonical hello to the allowed host dropped (not dialed)', cnt('api.anthropic.com') === 0 && s.closed())
}

// D — ClientHello split across two reads: no dial until the full record arrives, then it tunnels
{
  const s = await open('CONNECT allowed.test:443 HTTP/1.1\r\n\r\n')
  s.reset()
  const hello = buildClientHello('allowed.test'); const before = cnt('allowed.test')
  s.c.write(hello.slice(0, 6)); await delay(50)
  ck('e2e split: no dial on a partial ClientHello', cnt('allowed.test') === before)
  s.c.write(hello.slice(6)); s.c.write(Buffer.from('Z')); await delay(120)
  ck('e2e split: dials once the full ClientHello arrives', cnt('allowed.test') === before + 1)
  ck('e2e split: trailing byte tunnels through', s.recv().slice(-1).toString() === 'Z')
  s.c.destroy()
}

// E — allowlist is case-insensitive
{
  const s = await open('CONNECT Allowed.Test:443 HTTP/1.1\r\n\r\n')
  s.reset(); s.c.write(buildClientHello('Allowed.Test')); await delay(120)
  ck('e2e case-insensitive: mixed-case SNI matches the allowlist', cnt('Allowed.Test') === 1)
  s.c.destroy()
}

// F — CONNECT framing: non-443 port and non-CONNECT method are refused
{
  const s = await open('CONNECT allowed.test:80 HTTP/1.1\r\n\r\n')
  ck('e2e framing: CONNECT to a non-443 port → 403', s.status.startsWith('HTTP/1.1 403')); s.c.destroy()
}
{
  const s = await open('GET / HTTP/1.1\r\n\r\n')
  ck('e2e framing: non-CONNECT method → 405', s.status.startsWith('HTTP/1.1 405')); s.c.destroy()
}

await delay(50)
proxy.close(); fakeUpstream.close()
console.log(`\n  ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
