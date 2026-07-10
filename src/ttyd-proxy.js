// Guard-4 — the ttyd terminal proxy's security core. ttyd binds a per-member UNIX SOCKET (`-i <sock>`, not a TCP
// port) so a browser cannot open it directly (the Cross-Site WebSocket Hijack dies at the transport). The daemon
// proxies `/ttyd/<org>/<handle>` (HTTP + WS upgrade) to that member's ttyd socket, SAME-ORIGIN with the dashboard.
//
// That structural fix opens two INDIRECT holes the proxy MUST close (Pierre — else it's an RCE, a worse trade):
//   1. SSRF: if the target socket were resolved by PATH-JOINING the URL segments (`join(dir, org, handle)`), a
//      crafted `/ttyd/../../run/docker.sock` would make the daemon net.connect the DOCKER socket = container spawn
//      = host RCE. So the target is an ALLOWLIST LOOKUP into the KNOWN-live launch registry — `<org>/<handle>` are
//      KEYS, never path components. Anything not a live member (unknown, `..`, NUL, absolute) → null → 404.
//   2. Clickjacking: same-origin makes `/ttyd/*` framable; a cross-origin page iframes it (the WS Origin is then
//      legitimately the dashboard's → the Origin gate passes) and UI-redresses the user into typing into the live
//      `-W`-writable terminal. So `/ttyd/*` responses carry `frame-ancestors 'self'` (+ X-Frame-Options belt).
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'

// Resolve the ttyd unix-socket for a proxied terminal request. `org`/`handle` are UNTRUSTED URL segments — this
// treats them ONLY as KEYS into the live-member registry (loadLaunches()), so no traversal/absolute/NUL can escape
// to an arbitrary socket. Returns the socket path for a live member, else null (→ the caller 404s, never connects).
export function resolveTtydTarget(org, handle, launches) {
  if (typeof org !== 'string' || typeof handle !== 'string') return null
  if (org.includes('\0') || handle.includes('\0')) return null            // NUL-injection — reject outright
  const rec = launches && Object.prototype.hasOwnProperty.call(launches, org) ? launches[org] : null   // own-property only (no proto/__proto__ walk)
  const members = rec && rec.members
  const m = members && Object.prototype.hasOwnProperty.call(members, handle) ? members[handle] : null
  const sock = m && m.ttydSock
  return (typeof sock === 'string' && sock) ? sock : null                 // a member with no live ttydSock → null
}

// A belt on the RCE-adjacent net.connect (Pierre, optional-but-taken): confirm the resolved socket REALPATHS to
// inside the expected ttyd-socket dir before connecting. resolveTtydTarget already closes the SSRF (keys, not
// paths), so this can only fire if `ttydSock` in the host-only registry were ever poisoned to point elsewhere —
// which it can't be today (host-set, unmounted). But this makes "no SSRF" true BY CONSTRUCTION, not by that latent
// premise: a socket that resolves outside the dir (or doesn't resolve at all) → false → the caller 404s, never
// connects. realpath is injectable for tests. Reject a `/`-dir (would make every path "within").
export function ttydSockWithinDir(sock, sockDir, realpath = realpathSync) {
  if (typeof sock !== 'string' || typeof sockDir !== 'string' || !sockDir || sockDir === sep) return false
  let rp, rdir
  try { rp = realpath(sock); rdir = realpath(sockDir) } catch { return false }   // a socket not on disk (mid-launch / gone) → not connectable
  return rp === rdir || rp.startsWith(rdir.endsWith(sep) ? rdir : rdir + sep)     // within the dir (or the dir itself)
}

// Parse `/ttyd/<org>/<handle>/<rest>` from a request pathname. The handle is `first/backend` (contains a `/`), so
// the launcher encodes org+handle as SINGLE URL-encoded segments — `url.pathname` keeps `%2F` encoded (Node does
// not decode it), so parts[2]/parts[3] are the whole encoded org/handle and `rest` is the ttyd sub-path. Returns
// { org, handle, rest } (org/handle DECODED, to be used as registry KEYS — decode is safe because resolveTtydTarget
// treats them as keys: `%2E%2E`→`..` and `%00`→NUL both fail the key lookup / NUL guard). Null if not a /ttyd path.
export function parseTtydPath(pathname) {
  if (typeof pathname !== 'string') return null
  const parts = pathname.split('/')          // '/ttyd/o/h/rest' → ['', 'ttyd', 'o', 'h', 'rest', ...]
  if (parts[1] !== 'ttyd' || !parts[2] || !parts[3]) return null
  let org, handle
  try { org = decodeURIComponent(parts[2]); handle = decodeURIComponent(parts[3]) } catch { return null }   // malformed %-encoding → reject
  return { org, handle, rest: parts.slice(4).join('/') }
}

// The SHARED gate→resolve→belt decision for a /ttyd request (both the HTTP path AND the WS `'upgrade'` handler run
// this — one place so the upgrade can't silently skip a check the request handler did). Order is load-bearing
// (Pierre): Origin+Host FIRST (a WS handshake can't carry the X-MRC-Token, so the terminal's browser-protection
// rests entirely on Origin+Host — a cross-site page's WS carries its own Origin → reject; a rebind → Host reject),
// THEN decode+resolve (registry KEY, SSRF-safe), THEN the realpath within-dir belt — ALL before any net.connect.
// Returns { sock, rest } to proxy, or { reject:{ code, reason } } to refuse. A MISSING Origin passes the origin
// check (a non-browser host-local client — deliberate posture; a browser always sends Origin on a cross-site WS).
export function resolveTtydRequest(req, { launches, sockDir, originIsSelf, hostIsSelf, within = ttydSockWithinDir, resolve = resolveTtydTarget }) {
  const h = (req && req.headers) || {}
  if (h.origin && !originIsSelf(h.origin)) return { reject: { code: 403, reason: 'cross-origin' } }
  if (!hostIsSelf(h.host)) return { reject: { code: 403, reason: 'bad-host (possible DNS-rebinding)' } }
  let pathname
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname } catch { return { reject: { code: 400, reason: 'bad-url' } } }
  const parsed = parseTtydPath(pathname)
  if (!parsed) return { reject: { code: 404, reason: 'not-a-ttyd-path' } }
  const sock = resolve(parsed.org, parsed.handle, launches)              // decoded org/handle as KEYS — ../ / NUL / proto → null
  if (!sock) return { reject: { code: 404, reason: 'unknown-member' } }
  if (!within(sock, sockDir)) return { reject: { code: 404, reason: 'socket-outside-dir' } }   // no-SSRF-by-construction belt, BEFORE connect
  return { sock, rest: parsed.rest }
}

// The anti-clickjack headers for every /ttyd/* response (incl. the WS-upgrade's initial HTTP). frame-ancestors is
// the modern control; X-Frame-Options is the legacy belt. Only the dashboard's own origin may frame the terminal.
export function ttydSecurityHeaders() {
  return {
    'content-security-policy': "frame-ancestors 'self'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',   // the terminal page never leaks a Referer to any sub-resource it loads
    'cache-control': 'no-store',
  }
}
