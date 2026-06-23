#!/usr/bin/env node
//
// sni-proxy.js — Host-side SNI-pinning egress proxy for a CAGED adversary (A/#40).
//
// The problem it closes: the cage pins egress by IP, but api.anthropic.com is a
// SHARED Cloudflare edge — a foreign SNI aimed at the pinned IP completes a real
// TLS handshake and rides to another tenant. An L3/L4 (iptables/ipset) firewall
// is SNI-blind and CANNOT see "which apartment" the call asked for, only the
// street address. So a malicious/injected adversary could exfil the repo to an
// attacker-owned Cloudflare-fronted host. (Proven live, 2026-06-20.)
//
// The fix: the cage gets ZERO direct external egress; HTTPS_PROXY points every
// TLS call at THIS host process. We accept `CONNECT host:443`, then PEEK the
// ClientHello SNI INSIDE the tunnel and forward only if the SNI is allowlisted,
// connecting out to the validated SNI host (NOT the CONNECT host) — so a foreign
// SNI smuggled inside `CONNECT api.anthropic.com` is still caught. No MITM, no
// cert: the SNI is exactly what the CDN edge routes on, so pinning it pins the
// real destination. Adversary-cage-only — normal sessions never touch this.
//
import { createServer, connect } from 'node:net'
import { log } from '../output.js'

const PREFIX = 'sni-proxy'
const DEFAULT_ALLOW = ['api.anthropic.com', 'platform.claude.com']
// 5-byte TLS record header + the max 16384-byte TLS plaintext fragment. A real
// ClientHello fits well inside one record; anything larger is malformed/hostile.
const MAX_HELLO = 5 + 16384
const REQ_CAP = 8192          // cap on the CONNECT request-header bytes
const PEEK_TIMEOUT_MS = 15000 // anti-slowloris: must finish CONNECT + ClientHello within this

// Parse the host_name SNI out of a TLS ClientHello — STRICTLY. Pure byte inspection, no decryption.
// Returns:
//   { sni: '<host>' }  — exactly one canonical, allowlist-shaped server_name found
//   { need: true }     — not enough bytes yet; caller should buffer more
//   { sni: null }      — anything else → DROP
//
// The strictness is the security property (A/#40, Pierre's primary finding). We forward the client's raw
// bytes upstream, so Cloudflare's BoringSSL re-parses the SAME bytes for routing. If our parse and its
// parse could DISAGREE about the SNI, an attacker crafts a ClientHello that reads `api.anthropic.com` to us
// and `attacker-cf-zone.com` to Cloudflare → exfil. To make a differential impossible by construction, we
// accept ONLY a canonical ClientHello and fail closed on every ambiguity: the handshake must be a single
// message that EXACTLY fills one record (no fragmentation, no trailing messages); the extensions must fill
// the handshake exactly; there must be EXACTLY ONE server_name extension carrying EXACTLY ONE host_name with
// no trailing bytes; and the host_name must be byte-exact LDH+dot (no ASCII-coercion games — 0xE1 must NOT
// fold to 'a'). A hello we accept has one unambiguous reading, so upstream cannot read a different name.
export function parseClientHelloSNI(buf) {
  const need = { need: true }
  const none = { sni: null }

  // TLS record header (5): content_type(1) version(2) length(2)
  if (buf.length < 5) return need
  if (buf[0] !== 0x16) return none                 // not a handshake record
  const recLen = buf.readUInt16BE(3)
  if (recLen < 4 || recLen > 16384) return none    // too small for a handshake header / exceeds a TLS fragment
  if (buf.length < 5 + recLen) return need         // wait for the whole record
  const end = 5 + recLen                           // never read past the record

  // Handshake header: msg_type(1) length(3). The ClientHello MUST be one complete message filling the record
  // exactly — a fragmented hello (hsLen > record) or one with trailing bytes (hsLen < record) is non-canonical
  // → drop. This is what guarantees we and BoringSSL parse the identical, whole message.
  //
  // INTENTIONALLY stricter than BoringSSL (Pierre F-round-2): RFC 8446 permits a ClientHello fragmented across
  // multiple TLS records, and BoringSSL reassembles — we don't, so {hellos we accept} ⊊ {hellos CF accepts}.
  // That's the SAFE direction (any ambiguity → drop → fail closed, never a ride). Node/OpenSSL sends its
  // ClientHello as ONE record today, but fragmentation is DISCRETIONARY (RFC-allowed at ANY size — an anti-DPI
  // splitter, ECH GREASE, or a stack bump can split a 2 KB hello), so the brick trigger is "any multi-record
  // hello", NOT a 16 KB threshold (Pierre F-round-4 correction). We keep it single-record-strict on purpose
  // rather than add reassembly: reassembly is differential-risk surface on a security boundary (a reassembly
  // bug could REOPEN the ride). The residual risk is fail-CLOSED bricking, NOT exfil, and it's observable — a
  // dropped legit hello logs "DROP non-canonical… via CONNECT api.anthropic.com" below. If that fires on a REAL
  // agent hello (watch the live gate), the fix is to reassemble consecutive handshake records THEN strict-parse
  // the reassembled message (as-strict-as-BoringSSL, not stricter) — do NOT just loosen these checks.
  //
  // ARCHITECTURAL CEILING — ECH (Pierre F-round-4): this whole approach assumes the SNI is PLAINTEXT and
  // routing-authoritative. Encrypted ClientHello exists to defeat exactly on-path SNI inspection like this.
  // Under ECH we'd see only the outer public_name and either (a) BRICK (public_name not allowlisted) or (b) if
  // someone allowlists the public_name to fix the brick, the inner SNI is unconstrained + invisible and the
  // ride REOPENS. Today the cage's no-DNS blocks the client fetching its ECH config (HTTPS/SVCB RR) → plaintext
  // SNI fallback — but that's ACCIDENTAL + fragile, not a designed control. SNI-pinning's shelf life is tied to
  // ECH non-adoption in the agent's TLS stack; when ECH lands, the durable replacement is egress through an
  // authenticated forward path (e.g. mTLS to a known endpoint), not SNI inspection.
  if (buf[5] !== 0x01) return none                 // not a ClientHello
  const hsLen = (buf[6] << 16) | (buf[7] << 8) | buf[8]
  if (4 + hsLen !== recLen) return none            // handshake must fill the record exactly (see note above)
  let p = 9

  // client_version(2) + random(32)
  p += 34
  if (p > end) return none
  // session_id
  if (p + 1 > end) return none
  p += 1 + buf[p]
  if (p > end) return none
  // cipher_suites
  if (p + 2 > end) return none
  p += 2 + buf.readUInt16BE(p)
  if (p > end) return none
  // compression_methods
  if (p + 1 > end) return none
  p += 1 + buf[p]
  if (p > end) return none
  // extensions: length(2) + block that must fill the rest of the handshake EXACTLY (no trailing bytes)
  if (p + 2 > end) return none
  const extLen = buf.readUInt16BE(p)
  p += 2
  if (p + extLen !== end) return none
  const extEnd = end

  let sni = null
  let sniExtCount = 0
  let ech = false                                  // ECH canary (Pierre F-round-4): observe encrypted_client_hello
  while (p + 4 <= extEnd) {
    const type = buf.readUInt16BE(p)
    const len = buf.readUInt16BE(p + 2)
    p += 4
    if (p + len > extEnd) return none
    if (type === 0xfe0d) ech = true                // encrypted_client_hello present → real SNI is encrypted (unseen)
    if (type === 0x0000) {                         // server_name
      if (++sniExtCount > 1) return none           // duplicate server_name extension → ambiguous → drop
      const dataEnd = p + len
      let q = p
      if (q + 2 > dataEnd) return none
      const listLen = buf.readUInt16BE(q)
      q += 2
      if (q + listLen !== dataEnd) return none      // server_name_list must fill the extension exactly
      let hostCount = 0
      while (q + 3 <= dataEnd) {
        const nameType = buf[q]
        const nameLen = buf.readUInt16BE(q + 1)
        q += 3
        if (q + nameLen > dataEnd) return none
        if (nameType === 0x00) {                    // host_name
          if (++hostCount > 1) return none          // duplicate host_name → drop
          if (nameLen === 0) return none
          for (let i = q; i < q + nameLen; i++) {
            const c = buf[i]
            const ldh = (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) ||
                        (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d
            if (!ldh) return none                   // non-LDH byte (block encoding/coercion games) → drop
          }
          sni = buf.toString('latin1', q, q + nameLen)  // bytes are LDH-validated, so byte-exact
        }
        q += nameLen
      }
      if (q !== dataEnd) return none                // trailing bytes in the server_name_list → drop
      if (hostCount !== 1) return none              // server_name ext must carry exactly one host_name
    }
    p += len
  }
  if (p !== extEnd) return none                     // trailing bytes after the extensions → drop
  if (sniExtCount !== 1 || !sni) return { sni: null, ech }   // exactly one server_name ext, with a host_name
  return { sni, ech }
}

function isAllowed(sni, allow) {
  return !!sni && allow.includes(sni.toLowerCase())
}

// Start the proxy on 127.0.0.1:<port> (matches clipboard/notify — the container
// reaches it via host.docker.internal). Resolves with the net.Server.
// `dialUpstream` is an internal seam (default: a real net.connect to SNI:443)
// so tests can splice a local fake upstream; production always uses the default.
export function startSniProxy(port, { allowlist = DEFAULT_ALLOW, dialUpstream } = {}) {
  const allow = allowlist.map(h => h.toLowerCase())
  const dial = dialUpstream || (sni => connect({ host: sni, port: 443 }))
  return new Promise((resolve, reject) => {
    const server = createServer(client => {
      client.on('error', () => client.destroy())
      client.setTimeout(PEEK_TIMEOUT_MS, () => client.destroy())

      // Phase 1 — read the CONNECT request line + headers (until CRLFCRLF).
      let head = Buffer.alloc(0)
      const onHead = chunk => {
        head = Buffer.concat([head, chunk])
        const idx = head.indexOf('\r\n\r\n')
        if (idx === -1) { if (head.length > REQ_CAP) client.destroy(); return }
        client.removeListener('data', onHead)
        const reqLine = head.slice(0, head.indexOf('\r\n')).toString('ascii')
        const after = head.slice(idx + 4)          // any pipelined ClientHello bytes
        const m = /^CONNECT\s+([^\s:]+):(\d+)\s+HTTP\/1\.[01]$/i.exec(reqLine)
        if (!m) return void client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
        if (Number(m[2]) !== 443) return void client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        client.write('HTTP/1.1 200 Connection established\r\n\r\n')
        peek(client, after, m[1])
      }
      client.on('data', onHead)
    })

    // Phase 2 — peek the in-tunnel ClientHello SNI, then tunnel or drop.
    const peek = (client, initial, connectHost) => {
      let buf = initial
      const onData = chunk => { buf = Buffer.concat([buf, chunk]); decide() }
      const decide = () => {
        const r = parseClientHelloSNI(buf)
        if (r.need) {
          if (buf.length > MAX_HELLO) { log(PREFIX, `DROP oversized ClientHello via CONNECT ${connectHost}`); client.destroy() }
          return
        }
        client.removeListener('data', onData)
        // ECH canary (Pierre F-round-4): if encrypted_client_hello is present, the REAL SNI is encrypted and we
        // can't constrain it — this fires the day the agent starts negotiating ECH (the no-DNS reprieve ending),
        // turning a silent brick-or-bypass into a logged signal. Best-effort: only seen on a well-formed hello.
        if (r.ech) log(PREFIX, `NOTICE ECH (encrypted_client_hello / 0xfe0d) via CONNECT ${connectHost} — real SNI encrypted/unseen; SNI-pinning can't constrain it (brick-or-bypass; see parseClientHelloSNI + docs ECH ceiling).`)
        if (!isAllowed(r.sni, allow)) {
          // Distinguish a genuine foreign SNI (the attack we drop) from a strict-parse reject (sni===null). The
          // latter on CONNECT api.anthropic.com would mean the parser refused a REAL agent hello (over-strict —
          // see parseClientHelloSNI) → the cage is bricked, not under attack. Make that visible in the live gate.
          log(PREFIX, r.sni === null
            ? `DROP non-canonical/unparseable ClientHello via CONNECT ${connectHost} (strict-parse rejected)`
            : `DROP foreign SNI=${r.sni} via CONNECT ${connectHost}`)
          client.destroy()
          return
        }
        // Pause so no in-flight bytes are lost while upstream connects, then
        // replay the peeked ClientHello and splice the two sockets together.
        client.pause()
        const upstream = dial(r.sni)
        upstream.once('connect', () => {
          client.setTimeout(0)                     // clear the peek deadline; the tunnel is live
          if (buf.length) upstream.write(buf)
          client.pipe(upstream)
          upstream.pipe(client)
          client.resume()
          log(PREFIX, `tunnel SNI=${r.sni}`)
        })
        upstream.on('error', e => { log(PREFIX, `upstream ${r.sni} error: ${e.message}`); client.destroy() })
        upstream.on('close', () => client.destroy())
        client.on('close', () => upstream.destroy())
        client.on('error', () => upstream.destroy())
      }
      client.on('data', onData)
      if (buf.length) decide()
    }

    server.listen(port, '127.0.0.1', () => {
      log(PREFIX, `SNI-pinning egress proxy on 127.0.0.1:${port} (allow: ${allow.join(', ')})`)
      resolve(server)
    })
    server.on('error', reject)
  })
}

// Direct invocation: node sni-proxy.js <port> [allowed,hosts]
if (process.argv[1]?.endsWith('sni-proxy.js') && process.argv[2]) {
  startSniProxy(Number(process.argv[2]), process.argv[3] ? { allowlist: process.argv[3].split(',') } : {})
}
