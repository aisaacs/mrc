// Local web dashboard for negotiation rooms. Host-only, binds to 127.0.0.1. Shows every room's
// thread.log + consensus.md (live and historical, polled in near-real-time) and exposes the
// room-level controls (pause/resume/steer/end) by proxying to the daemon's control socket. No
// external dependencies — http + fs + the existing control protocol. It deliberately cannot post
// into a chat; the only writes are the room controls and marking a catch-up reviewed.
import http from 'node:http'
import net from 'node:net'
import { randomBytes, createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, chmodSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ASSET_CONTENT_TYPES, safeAssetPath } from './safe-path.js'
import { roomsRoot, roomDir, listRooms, readCatchups, updateCatchup, readTranscript, atomicWriteFileSync, loadLaunches, controlSecret } from './rooms.js'
import { resolveTtydRequest, ttydSecurityHeaders } from './ttyd-proxy.js'   // guard-4: ttyd unix-socket + same-origin proxy
import { findFreePort } from './ports.js'
import { parseRoster, validateRoster, editPersona } from './teams/roster.js'
import { realpath as realpathP, stat as statP, readdir as readdirP } from 'node:fs/promises'   // P1 repo-picker: async, bounded I/O for the validate oracle + the folder-chooser dir-enumeration (never block the daemon event loop)
import { readdirSync } from 'node:fs'
import { expandHome, loadAuthorizedRepos, listAllAuthorizedRepos } from './teams/repo-auth.js'   // P1 repo-picker: validate + this-org's authorized set + the union for "recent (other projects)"
import { storeCtx, mrcStoreDir } from './mrc-store.js'   // REBUILD session-picker: resolve the getId(repoPath) read root — the EXACT slice `mrc <repo>` opens (repoSliceDir lattice), disjoint from member/adv slices
import { loadNames, getSummaryPreview } from './sessions/manager.js'   // session-picker: STORED metadata only (names file + summary file) — NEVER a transcript-body read
import { ROLES } from './teams/personas.js'
import { NAME_STYLES, NAME_STYLE_NAMES } from './teams/names.js'
import { isMediaRole } from './teams/media.js'

const metaPath = () => join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json')
const daemonMeta = () => { try { return JSON.parse(readFileSync(metaPath(), 'utf8')) } catch { return null } }
const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const HTML_FILE = fileURLToPath(new URL('./dashboard.html', import.meta.url))   // unified, teams-first app
const SAFE_MD_FILE = fileURLToPath(new URL('./safe-md.js', import.meta.url))     // #63-A: the ONE audited esc/safeMD, injected into the page so the browser runs the same module the tests import

// #63-A: inline the safe-md module into the served doc so every client sink uses the SINGLE audited path
// (no duplicate, no drift). Strip the ES `export` keywords → the fns become page globals. Make the injected
// <script> PARSER-PROOF by ASSERT, not transform (Apolline's call): a blanket `</script`→`<\/script` replace
// is safe in a string/comment but SILENTLY corrupts a regex/code context (`/<script>/` → `/<\script>/` turns
// the literal into the `\s` whitespace class) — a silent break on the security primitive. So instead FAIL
// LOUD if the module ever contains a script-tag or comment-open token (`</script` / `<script` / `<!--`, which
// would otherwise close or double-escape the injected block). It emits none today (only <pre>/<code>/<strong>/
// <a>/<ul>/<li>/<br>), so this is a no-op now; a future edit introducing one must encode it deliberately
// (String.fromCharCode / split) rather than get a silently-broken regex. Fail-loud, consistent with the
// daemon's version-stamp / surfaced-import-failure discipline. (No attacker data is ever templated here — the
// block is the static module only; member text is escaped by safeMD at runtime, never entering the source.)
// Inject-time ASSERT, fail-loud (team-converged: an ASSERT, never a backslash-transform — a transform can
// silently corrupt a future regex, e.g. /<script>/ → /<\script>/ flips `<script` to `<`+`\s`). Dead-simple
// conservative substring: throw on ANY `</script`/`<script`/`<!--` (case-insensitive). Over-matching a benign
// `</scripture` only fail-louds (forces a deliberate fromCharCode/split encode) — never corrupts. No-op today
// (the module emits only <pre>/<code>/<strong>/<em>/<a>/<ul>/<li>/<br>; "script"/"<!--" absent). Exported for
// the gate test. Returns the source (chainable) so callers can assert-then-transform.
export function rejectScriptTokens(src) {
  if (/<\/?script|<!--/i.test(String(src))) {
    throw new Error('safe-md.js must not contain a literal "</script", "<script", or "<!--" (it would break the injected <script> block) — encode such text via String.fromCharCode/split instead')
  }
  return src
}
function safeMdInline() {
  return rejectScriptTokens(readFileSync(SAFE_MD_FILE, 'utf8')).replace(/^export\s+/gm, '')
}
// Normalize a roster object/JSON into { norm, validation } or { error }. Pure — no disk/daemon.
function previewRoster(input) {
  try {
    const norm = parseRoster(input, {})
    return { ok: true, org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms, validation: validateRoster(norm) }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

// One request/response to the daemon control socket. Never throws — returns {ok:false,error} so the
// dashboard degrades gracefully when the daemon is down (historical rooms still browse fine).
function ctrl(controlPort, action, extra = {}) {
  return new Promise((resolve) => {
    if (!controlPort) return resolve({ ok: false, error: 'no room daemon running' })
    const c = net.connect(controlPort, '127.0.0.1', () => c.write(JSON.stringify({ action, ...extra }) + '\n'))
    let buf = '', done = false
    const finish = (v) => { if (!done) { done = true; resolve(v); try { c.end() } catch {} } }
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { finish(JSON.parse(buf.slice(0, i))) } catch { finish({ ok: false, error: 'bad daemon reply' }) } } })
    c.on('error', () => finish({ ok: false, error: 'room daemon not reachable' }))
    setTimeout(() => finish({ ok: false, error: 'daemon timeout' }), 3000)
  })
}

// roomId is attacker-controlled (query/body), so only ever accept ids that are real room dirs —
// this whitelists against listRooms() and so closes path-traversal (../) entirely.
const knownRoom = (id) => typeof id === 'string' && listRooms().some((r) => r.roomId === id)

async function buildState() {
  const meta = daemonMeta()
  let status = { ok: false }
  if (meta?.controlPort) status = await ctrl(meta.controlPort, 'status')
  const live = status?.ok ? status : { sessions: [], pairings: [] }
  const byId = new Map((live.pairings || []).map((p) => [p.roomId, p]))
  const rooms = listRooms().map((r) => {
    let updatedAt = r.meta?.createdAt || 0
    try { updatedAt = statSync(join(r.dir, 'thread.log')).mtimeMs } catch {}
    const lp = byId.get(r.roomId)
    const unreviewed = readCatchups(r.roomId).filter((c) => c.status === 'ready' && !c.reviewedAt).length
    return {
      roomId: r.roomId,
      a: lp?.a || r.meta?.repoA || '?',
      b: lp?.b || r.meta?.repoB || '?',
      aAdversary: lp?.aAdversary || undefined,   // D9: daemon-computed containment flag per side (only for a LIVE pairing; a historical room has no live adversary to badge)
      bAdversary: lp?.bAdversary || undefined,
      live: !!lp,
      state: lp ? lp.state : 'History',
      pauseReason: lp?.pauseReason || null,
      turn: lp?.turn ?? null,
      turnCap: lp?.turnCap ?? null,
      autoCatchup: lp?.autoCatchup ?? false,   // default OFF (owner pref) — matches the pairing/engine default; a pause doesn't auto-elicit a handoff unless opted in
      unreviewed,
      createdAt: r.meta?.createdAt || 0,
      updatedAt,
    }
  // Float rooms that want your eyes (unreviewed catch-ups) to the top, then live, then most-recent.
  }).sort((x, y) => (Number(y.unreviewed > 0) - Number(x.unreviewed > 0)) || (Number(y.live) - Number(x.live)) || (y.updatedAt - x.updatedAt))
  return {
    daemon: { running: !!(meta && status?.ok), version: status?.version || null, controlPort: meta?.controlPort || null },
    sessions: live.sessions || [],
    rooms,
  }
}

function sendJSON(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) }
// #69-A: ETag + conditional-304 for the heavy POLL reads. The dashboard re-fetches /api/teams (~277 KB, mostly
// the static roster/topology + the accumulated @user inbox) and /api/state every ~1.5s, but across ticks the
// payload is usually byte-identical (only context/rate-limit/turn/online change, and only when something happens).
// `Cache-Control: no-cache` makes the browser REVALIDATE each fetch (send If-None-Match) rather than skip the
// cache; an unchanged body → 304 with NO body → the transfer is saved (~all of it when idle) while fetch still
// resolves with the cached JSON. Read-only, same bytes the GET already serves — no new surface. (The daemon still
// recomputes the body to hash it; CPU isn't the bottleneck, the repeated 277 KB transfer is.)
export function sendJSONCached(req, res, obj) {
  const body = JSON.stringify(obj)
  const etag = '"' + createHash('sha1').update(body).digest('base64') + '"'
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': 'no-cache' }); return res.end() }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache', etag })
  res.end(body)
}

// #56: ASSET_CONTENT_TYPES + safeAssetPath now live in ./safe-path.js (the single audited implementation,
// shared with the room daemon's send_photo). Imported above for internal use; re-exported here so any
// existing importer of rooms-dashboard.js stays valid.
export { ASSET_CONTENT_TYPES, safeAssetPath }

// --- CSRF defense for the browser-only HTTP surface (2b.1) --------------------------------------
// The HTTP `/api` surface is reachable only by a browser (the `mrc rooms/team` CLIs use the control
// socket). A page the user happens to visit could POST to 127.0.0.1:<port> to drive state-changers.
// Defense: a per-daemon CSRF token embedded in the served HTML and required on every state-changing
// POST. A cross-origin page can FIRE a request but cannot READ the token (same-origin policy — and we
// never emit `Access-Control-Allow-Origin`), so it can't forge one. Origin + Host checks are belt-and-
// suspenders against DNS-rebinding/localhost spoof.
//
// The token is PERSISTED (0600) across restarts (#20): it used to be memory-only and rotated on every
// restart, so an already-open tab held a stale token and its next state-change POST 403'd — and @user
// restarts often. Persisting is NOT a CSRF downgrade: the defense rests on cross-origin being unable to
// READ the token (same-origin policy), which holds whether it lives in memory or on disk. The only new
// exposure is a LOCAL same-machine user reading ~/.local/share/mrc/ — who already reads the repo's
// `.env` (real bot token / API keys), so the CSRF token isn't the weak link in that threat model. We
// keep it in a DEDICATED 0600 file (not room-daemon.json — the daemon rewrites that file AFTER
// startDashboard runs, which would clobber a token merged in here). The SPA also handles a 403 anyway
// (no optimistic-close; surfaces "reload to continue"), so a genuine mismatch is never silently dropped.
const tokenPath = () => join(homedir(), '.local', 'share', 'mrc', 'dashboard-token')
function loadOrMintToken() {
  try { const t = readFileSync(tokenPath(), 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(t)) { try { chmodSync(tokenPath(), 0o600) } catch {} ; return t } } catch {}
  const t = randomBytes(32).toString('hex')
  try { mkdirSync(dirname(tokenPath()), { recursive: true }); writeFileSync(tokenPath(), t, { mode: 0o600 }); chmodSync(tokenPath(), 0o600) } catch {}
  return t
}
let DASH_TOKEN = ''   // loaded/minted at startDashboard; persisted 0600 so an open tab survives a restart
let DASH_PORT = 0
const sseClients = new Set()   // #69-B: open /api/events responses; the daemon's delta bus fans out to these
let SSE_WIRED = false          // subscribe once per process (the daemon calls startDashboard once with `subscribe`)
const isLocalHostName = (h) => h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
function originIsSelf(origin) {
  try { const u = new URL(origin); return isLocalHostName(u.hostname) && Number(u.port) === DASH_PORT } catch { return false }
}
function hostIsSelf(hostHeader) {
  if (!hostHeader) return false
  const m = String(hostHeader).match(/^(.*?)(?::(\d+))?$/)
  const host = (m?.[1] || '').replace(/^\[|\]$/g, '')
  return isLocalHostName(host) && Number(m?.[2] || 0) === DASH_PORT
}
// Returns null if allowed, else a {code,error} to reject with. Checked BEFORE the body is consumed.
function rejectStateChange(req) {
  if (!DASH_TOKEN || req.headers['x-mrc-token'] !== DASH_TOKEN) return { code: 403, error: 'forbidden: missing or invalid X-MRC-Token (reload the dashboard)' }
  const origin = req.headers['origin']
  if (origin && !originIsSelf(origin)) return { code: 403, error: 'forbidden: cross-origin request' }
  if (!hostIsSelf(req.headers['host'])) return { code: 403, error: 'forbidden: unexpected Host (possible DNS-rebinding)' }
  return null
}
// #69-B: DNS-rebinding read-gate for the SENSITIVE reads — the SSE stream (mandatory) + the heavy state reads
// (defense-in-depth). SOP already blocks the SIMPLE cross-origin read (the daemon sends no Access-Control-Allow-
// Origin → the response is opaque, and a cross-origin EventSource is rejected), but NOT DNS-rebinding (a rebind
// to 127.0.0.1 makes the browser treat the request as same-origin, so SOP allows the read). This is the SAME
// Origin+Host check the state-changing POSTs already use (rejectStateChange), applied to these reads because
// they carry continuous/bulk room state — closing the read-vs-POST asymmetry. NO token (reads carry none, and
// EventSource cannot send custom headers — CSRF is the wrong tool for a read); the legit same-origin dashboard
// passes (127.0.0.1 → 127.0.0.1). Only the Origin/Host control, which is exactly what DNS-rebinding defeats.
function rejectRead(req) {
  const origin = req.headers['origin']
  if (origin && !originIsSelf(origin)) return { code: 403, error: 'forbidden: cross-origin request' }
  if (!hostIsSelf(req.headers['host'])) return { code: 403, error: 'forbidden: unexpected Host (possible DNS-rebinding)' }
  return null
}

// ── guard-4: the ttyd terminal proxy. ttyd listens on a per-member UNIX SOCKET (a browser can't open one → the
// CSWSH dies at the transport); the dashboard proxies /ttyd/<org>/<handle> to it SAME-ORIGIN so the dashboard's
// Origin/Host gate + frame-ancestors protect the writable terminal. resolveTtydRequest (ttyd-proxy.js) does the
// gate→resolve(registry-KEY, SSRF-safe)→within-dir belt BEFORE any net.connect. ──
const ttydSockDir = () => join(homedir(), '.local', 'share', 'mrc', 'sockets')   // matches team.js socketDir()
const ttydDeps = () => ({ launches: loadLaunches(), sockDir: ttydSockDir(), originIsSelf, hostIsSelf })

// Proxy a /ttyd HTTP request to the member's ttyd unix socket, injecting frame-ancestors onto the framable response.
function proxyTtydHttp(req, res, sock, rest, search) {
  const up = http.request({ socketPath: sock, path: '/' + rest + (search || ''), method: req.method, headers: { ...req.headers, host: 'ttyd' } }, (ur) => {
    try { res.writeHead(ur.statusCode || 502, { ...ur.headers, ...ttydSecurityHeaders() }); ur.pipe(res) } catch { try { res.end() } catch {} }   // frame-ancestors OVERRIDES whatever ttyd emitted
  })
  up.on('error', () => { try { if (!res.headersSent) res.writeHead(502, ttydSecurityHeaders()); res.end() } catch {} })
  req.pipe(up)
}

// Proxy a /ttyd WebSocket UPGRADE to the member's ttyd unix socket. Runs on the server's SEPARATE 'upgrade' event
// (a request-handler-only gate would be silently bypassed here). Gate→resolve→belt, THEN connect; on ANY reject
// (incl. an unknown member → null) socket.destroy() and RETURN — connect is NEVER reached. Teardown destroys BOTH
// on either close/error. `connect`/`decide` are injectable so a test can spy that connect is never called on reject.
export function proxyTtydUpgrade(req, socket, head, { connect = net.connect, decide = (r) => resolveTtydRequest(r, ttydDeps()) } = {}) {
  let url; try { url = new URL(req.url, 'http://127.0.0.1') } catch { try { socket.destroy() } catch {}; return }
  if (!url.pathname.startsWith('/ttyd/')) { try { socket.destroy() } catch {}; return }   // the dashboard has no other WS upgrades
  const dec = decide(req)
  if (dec.reject) { try { socket.destroy() } catch {}; return }   // gate/SSRF/belt failed → drop, NEVER connect
  let upstream
  const teardown = () => { try { socket.destroy() } catch {}; try { upstream?.destroy() } catch {} }
  socket.on('error', teardown); socket.on('close', teardown)
  upstream = connect(dec.sock, () => {
    const line = `${req.method} /${dec.rest}${url.search} HTTP/1.1\r\n` +
                 Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n'
    try { upstream.write(line); if (head && head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket) } catch { teardown() }
  })
  upstream.on('error', teardown); upstream.on('close', teardown)
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    // Gate EVERY state-changing request (all POSTs are state-changers; reads are GET) on the token +
    // same-origin/host, before consuming the body → a fast, side-effect-free 403 for forged requests.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const bad = rejectStateChange(req)
      if (bad) return sendJSON(res, bad.code, { ok: false, error: bad.error })
    }
    // guard-4: proxy /ttyd/<org>/<handle>/* to the member's ttyd unix socket (same-origin terminal). Its own
    // Origin/Host gate + registry-KEY resolve + within-dir belt run inside resolveTtydRequest, before any connect.
    if (url.pathname.startsWith('/ttyd/')) {
      const dec = resolveTtydRequest(req, ttydDeps())
      if (dec.reject) return sendJSON(res, dec.reject.code, { ok: false, error: dec.reject.reason })
      return proxyTtydHttp(req, res, dec.sock, dec.rest, url.search)
    }
    // Team builder: preview (pure), save team.json to a repo, or define rooms on the daemon.
    if (req.method === 'POST' && (url.pathname === '/api/team-preview' || url.pathname === '/api/team-save' || url.pathname === '/api/team-define')) {
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}') } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }) }
        const pv = previewRoster(j.roster)
        if (url.pathname === '/api/team-preview') return sendJSON(res, 200, pv)
        if (!pv.ok) return sendJSON(res, 400, pv)
        if (url.pathname === '/api/team-save') {
          // Localhost-only write: target an EXISTING directory; the filename is fixed to team.json.
          const repo = String(j.repo || '').trim()
          try { if (!repo || !statSync(repo).isDirectory()) throw new Error('repo must be an existing directory') }
          catch (e) { return sendJSON(res, 400, { ok: false, error: String(e?.message || e) }) }
          const file = join(repo, 'team.json')
          // Atomic write: team.json is the authoritative source the launcher reads — a torn write would
          // corrupt it and break launch. temp→fsync→rename (same helper the daemon's JSON state uses).
          try { atomicWriteFileSync(file, JSON.stringify(j.roster, null, 2) + '\n') } catch (e) { return sendJSON(res, 500, { ok: false, error: String(e?.message || e) }) }
          return sendJSON(res, 200, { ok: true, path: file })
        }
        // team-define: push the org to the daemon so its rooms exist (does NOT launch containers).
        // Pass the raw roster too, so the daemon can later launch this defined org from the GUI.
        const def = { org: pv.org, repo: pv.repo, members: pv.members, rooms: pv.rooms }
        // guard-1: the human's Build→Define (CSRF+Origin+Host-gated already) → trusted:true (first-pins the PICKED
        // repo), activate:false (INERT — activation is the separate LAUNCH gesture). Carry the host-only secret so
        // the daemon's capOk honors the capability (the dashboard runs in the daemon's uid → it can read the 0600 file).
        return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'defineOrg', { def, roster: j.roster, trusted: true, activate: false, secret: controlSecret() }))
      })
      return
    }
    // Custom personas (#42): add/update/remove a custom role in the project's team.json. CSRF-gated
    // above. The org→repo resolves server-side via getroster; the WRITE reuses team-save's path and
    // editPersona's parse-gate, so the editor can never persist a team.json the launcher would reject.
    if (req.method === 'POST' && url.pathname === '/api/personas') {
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}') } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }) }
        const op = j.op === 'remove' ? 'remove' : 'save'
        const gr = await ctrl(daemonMeta()?.controlPort, 'getroster', { org: j.org })
        const repo = gr?.repo || null
        if (!repo) return sendJSON(res, 400, { ok: false, error: 'unknown org (no repo on record) — define or launch the team first' })
        const file = join(repo, 'team.json')
        let data; try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { return sendJSON(res, 400, { ok: false, error: `cannot read ${file}: ${String(e?.message || e)}` }) }
        const r = editPersona(data, { op, key: j.key, persona: j.persona })
        if (!r.ok) return sendJSON(res, 400, r)   // parse-gate / reference-refusal → surfaced to the editor, no write
        try { atomicWriteFileSync(file, JSON.stringify(r.roster, null, 2) + '\n') } catch (e) { return sendJSON(res, 500, { ok: false, error: String(e?.message || e) }) }
        return sendJSON(res, 200, { ok: true, path: file, personas: r.roster.personas || {} })
      })
      return
    }
    // #42 chunk C: update global runtime prefs (turn-cap + notification prefs). CSRF-gated above; the
    // turn-cap applies live + persists via the daemon's setprefs (engine.setTurnCap → user-prefs.json).
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}') } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }) }
        const f = {}
        if (j.turnCap !== undefined) { const n = Number(j.turnCap); if (!Number.isFinite(n) || n < 0) return sendJSON(res, 400, { ok: false, error: 'turn-cap must be a number ≥ 0 (0 disables the pause-after-N)' }); f.turnCap = Math.floor(n) }
        if (j.notify !== undefined) { if (!j.notify || typeof j.notify !== 'object') return sendJSON(res, 400, { ok: false, error: 'notify must be an object' }); f.notify = j.notify }
        if (!Object.keys(f).length) return sendJSON(res, 400, { ok: false, error: 'nothing to update' })
        const r = await ctrl(daemonMeta()?.controlPort, 'setprefs', f)
        return sendJSON(res, r?.ok ? 200 : 500, r?.ok ? r : { ok: false, error: r?.error || 'daemon did not apply settings' })
      })
      return
    }
    // GUI launch lifecycle: start the live members (each in its own ttyd), stop them, add/remove a
    // member. All proxy to the daemon. (Member terminal switching is client-side now — each member has
    // its own ttyd, so the dashboard just swaps the iframe; the old /api/team-select is gone.)
    if (req.method === 'POST' && (url.pathname === '/api/team-launch' || url.pathname === '/api/team-stop' || url.pathname === '/api/team-delete' || url.pathname === '/api/team-add-member' || url.pathname === '/api/team-remove-member' || url.pathname === '/api/team-relaunch-member' || url.pathname === '/api/team-close-session' || url.pathname === '/api/kill-session' || url.pathname === '/api/authorize-repo' || url.pathname === '/api/graftresume' || url.pathname === '/api/team-web' || url.pathname === '/api/consult-dismiss' || url.pathname === '/api/consult-resume')) {
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}') } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }) }
        const cp = daemonMeta()?.controlPort
        // guard-1: these control-plane actions ACTIVATE / SPAWN / clear a pin — capabilities. The in-daemon dashboard
        // (already CSRF+Origin+Host-gated) carries the host-only secret; the daemon downgrades any assertion without it.
        const sec = controlSecret()
        // guard-1: the human's Launch click (CSRF-gated) carries the secret; launchteam first-pins the PICKED repo +
        // activates in one gesture (no separate Define step — fits the direct-GUI Build→Launch, keeps §0's bar).
        if (url.pathname === '/api/team-launch') return sendJSON(res, 200, await ctrl(cp, 'launchteam', { roster: j.roster, org: j.org, repo: j.repo, secret: sec }))
        if (url.pathname === '/api/team-stop') return sendJSON(res, 200, await ctrl(cp, 'stopteam', { org: j.org, secret: sec }))
        if (url.pathname === '/api/team-delete') return sendJSON(res, 200, await ctrl(cp, 'removeorg', { org: j.org, secret: sec }))   // #13: forget the project (no disk deletion)
        // Inc 1 (Model B / cross-repo): the human's dashboard pick of a differing agent repo becomes a RECORDED authorization.
        // CSRF+Origin+Host-gated at the front door (rejectStateChange, above) + carries the capOk secret → the daemon's
        // authorizerepo records it via addAuthorizedRepo. Additive + un-gated: it's the GUI form of the CLI cross-repo (Mouth B)
        // authorize, useful today; the launch path only READS the set (resolveMemberRepo) — a session can request, never authorize.
        if (url.pathname === '/api/authorize-repo') return sendJSON(res, 200, await ctrl(cp, 'authorizerepo', { org: j.org, repo: j.repo, secret: sec }))
        if (url.pathname === '/api/team-add-member') return sendJSON(res, 200, await ctrl(cp, 'addmember', { org: j.org, team: j.team, role: j.role, backend: j.backend, territory: j.territory, name: j.name, repo: j.repo, lead: j.lead, secret: sec }))   // #45/#46b: thread the added agent's repo + ★ lead (already authorized via /api/authorize-repo)
        if (url.pathname === '/api/graftresume') return sendJSON(res, 200, await ctrl(cp, 'graftresume', { org: j.org, handle: j.handle, ref: j.ref, uuid: j.uuid, secret: sec }))   // #44: resume a live agent from a DIFFERENT session (content transfer — capOk-gated, no repo grant)
        if (url.pathname === '/api/team-remove-member') return sendJSON(res, 200, await ctrl(cp, 'removemember', { org: j.org, handle: j.handle, secret: sec }))
        if (url.pathname === '/api/team-relaunch-member') return sendJSON(res, 200, await ctrl(cp, 'relaunchmember', { org: j.org, handle: j.handle, secret: sec }))   // #41: orphan recovery (kill-first → respawn)
        if (url.pathname === '/api/team-close-session') return sendJSON(res, 200, await ctrl(cp, 'closemember', { org: j.org, handle: j.handle, secret: sec }))   // §13 Close session: stop the member's session, KEEP it in the roster (≠ removemember)
        if (url.pathname === '/api/team-web') return sendJSON(res, 200, await ctrl(cp, 'setorgweb', { org: j.org, web: !!j.web, secret: sec }))   // #57: per-project --web egress toggle (capability → carries the secret; applies on next launch)
        if (url.pathname === '/api/consult-dismiss') return sendJSON(res, 200, await ctrl(cp, 'dismissconsult', { org: j.org, handle: j.handle, secret: sec }))   // #56: reap a caged consult Pierre (removeTransientConsult + kill container) — consult-scoped, never a team action
        if (url.pathname === '/api/consult-resume') return sendJSON(res, 200, await ctrl(cp, 'resumeconsult', { org: j.org, summonerHandle: j.summonerHandle, secret: sec }))   // #56 Inc2: resume a specific past caged Pierre (record-verified, cage re-derived, --continue his conversation)
        if (url.pathname === '/api/kill-session') return sendJSON(res, 200, await ctrl(cp, 'killsession', { id: j.id }))
        return sendJSON(res, 404, { ok: false, error: 'unknown team action' })
      })
      return
    }
    // Telegram pairing controls (#12): confirm/reject a pending chat, or unpair a linked one. The
    // confirm IS the trust gate, and it's here on the localhost dashboard (token-guarded above).
    if (req.method === 'POST' && url.pathname === '/api/tg') {
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}') } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }) }
        if (!['tgconfirm', 'tgreject', 'tgunpair'].includes(j.action)) return sendJSON(res, 400, { ok: false, error: 'action not allowed' })
        return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, j.action, { org: j.org, fromId: j.fromId }))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/team-presets') {
      const { listPresets, buildPreset } = await import('./teams/presets.js')
      return sendJSON(res, 200, { presets: listPresets().map((p) => ({ ...p, roster: buildPreset(p.name, {}) })) })
    }
    if (req.method === 'GET' && url.pathname === '/api/team-roster') {
      const meta = daemonMeta()
      const r = meta?.controlPort ? await ctrl(meta.controlPort, 'getroster', { org: url.searchParams.get('org') }) : { ok: false }
      return sendJSON(res, 200, r)
    }
    // P1 repo-picker (create-form): validate a human-typed repo path BEFORE the authorize call, so the "📁 repo"
    // field gives live feedback instead of an opaque failure at launch (the owner's #1 create-form pain). Read-only
    // and side-effect-free — it NEVER authorizes (that stays the human's PICK via the cap-gated /api/authorize-repo).
    // SECURITY (Pierre): this is an ARBITRARY-PATH filesystem oracle, so it's the sharp edge, not hygiene —
    //   (1) origin-gated with the SAME shared rejectRead as /api/state (a malicious browser page / DNS-rebind must
    //       not turn it into a "does ~/.ssh/id_rsa exist?" probe). The `{ok}` boolean IS STILL a filesystem
    //       existence probe on caller input — it's safe ONLY because rejectRead keeps it owner-origin-only, NOT
    //       because "a bool is harmless". Do not relax the gate thinking it just returns true/false.
    //   (2) MINIMAL RETURN — it computes the realpath only internally (to stat + set-compare) and returns just a
    //       yes/no + the already-authorized bit; it NEVER echoes the realpath of arbitrary input, so even a gate
    //       bypass can't use it as a symlink-target oracle;
    //   (3) NON-BLOCKING + BOUNDED — the Promise.race bounds the RESPONSE (a dead network mount / deep symlink
    //       chain / /proc path returns 'timed out' in ~2s); it does NOT cancel the underlying realpath, which
    //       keeps running off the event loop and resolves into the void — harmless precisely because it's async
    //       (the loop never blocks, which is the whole goal). Owner-only origin ⇒ no pending-op-accumulation DoS.
    if (req.method === 'GET' && url.pathname === '/api/validate-repo') {
      const bad = rejectRead(req); if (bad) return sendJSON(res, bad.code, { error: bad.error })
      const raw = String(url.searchParams.get('path') || '').trim()
      if (!raw) return sendJSON(res, 200, { ok: false, error: 'empty' })
      const org = url.searchParams.get('org') || ''
      const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 2000))
      try {
        const real = await Promise.race([realpathP(expandHome(raw)), deadline])
        const st = await Promise.race([statP(real), deadline])
        if (!st.isDirectory()) return sendJSON(res, 200, { ok: false, error: 'not a directory' })
        const authorized = org ? loadAuthorizedRepos(org).has(real) : false   // real used ONLY for the set-compare, never returned
        return sendJSON(res, 200, { ok: true, authorized })
      } catch (e) { return sendJSON(res, 200, { ok: false, error: /timed out/.test(String(e?.message)) ? 'timed out' : 'not found on disk' }) }
    }
    // P1 repo-picker: quick-pick source for the "📁 repo" field. Two LABELED groups (Pierre): `authorized` = this
    // org's already-authorized set (canonical realpaths), `recent` = the union of every OTHER org's vouched repos
    // (so a FRESH org with an empty own-set still gets bootstrap quick-picks instead of typing blind). Cross-org
    // visibility is NOT a leak — the dashboard is single-principal (one owner's orgs) — and every path is already
    // human-vouched; the union's only real risk is picking the WRONG org's repo, which the UI closes with the
    // "other projects" label, not by omission. Picking still routes through cap-gated authorize (visibility ≠ grant).
    // Origin-gated (same rejectRead). Only reads small local JSON (no arbitrary-input realpath) → sync is fine here.
    if (req.method === 'GET' && url.pathname === '/api/repos') {
      const bad = rejectRead(req); if (bad) return sendJSON(res, bad.code, { error: bad.error })
      const org = String(url.searchParams.get('org') || '').trim()
      const mine = org ? loadAuthorizedRepos(org) : new Set()
      // #46: exclude mrc-INTERNAL paths (org-anchors, the store, sockets — under ~/.local/share/mrc/) from the
      // quick-picks; those are never a user repo to pick (they showed up as unreadable `.mrc-g2-*` hex chips).
      const mrcDataDir = join(homedir(), '.local', 'share', 'mrc')
      const isInternal = (p) => String(p || '').startsWith(mrcDataDir + '/') || String(p || '') === mrcDataDir
      const authorized = [...mine].filter((p) => !isInternal(p)).sort()
      const recent = listAllAuthorizedRepos().filter((p) => !mine.has(p) && !isInternal(p)).sort()   // union minus this org's own set, minus mrc-internal
      return sendJSON(res, 200, { ok: true, authorized, recent })
    }
    // REBUILD (create-form §3/§13 Session picker): the prior sessions to resume for a repo — "the GUI for
    // `mrc pick`". SECURITY (Pierre surface-4 invariant):
    //   - READ ROOT = getId(repoPath) — the user's OWN repo memory slice (the EXACT slice `mrc <repo>` opens), via
    //     the same storeCtx→mrcStoreDir lattice as repoSliceDir. This is DISJOINT from any member `m-` slice or
    //     adversary `adv-` slice (different keyspaces) → the picker can NEVER surface another agent's session
    //     (the context-graft is unreachable by construction, not by a filter). Falls back to the legacy in-repo
    //     store; both are single-principal (the owner's own repo memory).
    //   - NON-MINTING: reads `.mrc-id` read-only (a READ endpoint must not create a store id) — missing/invalid id
    //     → no store slice → legacy fallback. repoPath is realpath'd + the slice key is a validated UUID
    //     (REPO_ID_RE) → traversal-safe, same injective-key property as authPath.
    //   - ZERO TRANSCRIPT READS: the list is built from `.jsonl` FILENAMES (uuids) + file mtime + the STORED
    //     names file + the STORED summary file — it never opens a conversation body. origin-gated (rejectRead).
    if (req.method === 'GET' && url.pathname === '/api/repo-sessions') {
      const bad = rejectRead(req); if (bad) return sendJSON(res, bad.code, { error: bad.error })
      const raw = String(url.searchParams.get('repo') || '').trim()
      if (!raw) return sendJSON(res, 200, { ok: true, sessions: [] })
      let real; try { real = realpathSync(expandHome(raw)) } catch { return sendJSON(res, 200, { ok: true, sessions: [] }) }
      const nonMintingRepoId = (repoPath) => {   // read `.mrc-id` WITHOUT minting (repoStoreId would create one); throw → no store slice → legacy
        const id = readFileSync(join(repoPath, '.mrc', '.mrc-id'), 'utf8').trim()
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return id
        throw new Error('no valid repo store id')
      }
      let dir = null
      try { const d = mrcStoreDir(storeCtx({ solo: false, memberCtx: null, cagedAdversary: false, repoPath: real }), { repoStoreId: nonMintingRepoId }); if (existsSync(d)) dir = d } catch {}
      if (!dir) { const legacy = join(real, '.mrc', 'projects', '-workspace'); if (existsSync(legacy)) dir = legacy }
      if (!dir) return sendJSON(res, 200, { ok: true, sessions: [] })
      let files = []; try { files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')) } catch {}
      const names = loadNames(dir)
      const sessions = files.map((f) => { const id = f.slice(0, -6); let ts = 0; try { ts = statSync(join(dir, f)).mtimeMs } catch {} ; return { id, name: names[id] || null, ts, preview: getSummaryPreview(dir, id) || null } })
        .sort((a, b) => b.ts - a.ts).slice(0, 50)
      return sendJSON(res, 200, { ok: true, sessions })
    }
    // REBUILD (create-form §13 "📁 Choose…"): the in-app folder chooser's data. A browser file input can't return a
    // host FOLDER path and a native OS dialog from a headless daemon is fragile, so the chooser is an in-app directory
    // browser backed by this endpoint. SECURITY (Pierre): this is a directory-ENUMERATION oracle — strictly worse than
    // validate-repo's existence check — so it's the sharp edge and gets the same three hardenings + the two-gate rule:
    //   (1) origin-gated with the SAME shared rejectRead as /api/state (owner-origin-only; a malicious page / rebind
    //       must not enumerate the host filesystem). It reveals the OWNER's own dir tree to the OWNER — zero marginal
    //       disclosure — but ONLY because rejectRead pins it there; do NOT relax the gate thinking "it's just names".
    //   (2) MINIMAL return — child directory NAMES only (real subdirs; no files, no contents, no sizes/mtimes, no
    //       symlink targets), plus the canonical realpath of the browsed dir (inherent to a chooser — the user is
    //       navigating it) so the client can build the full path + breadcrumb. Entry count capped.
    //   (3) NON-BLOCKING + BOUNDED — async fs raced against a deadline, so a dead mount / huge dir can't stall the
    //       daemon event loop. BROWSE IS READ-ONLY: it NEVER authorizes — selecting a folder only fills the field;
    //       the mount grant stays the separate cap-gated /api/authorize-repo (the two gates are never conflated).
    if (req.method === 'GET' && url.pathname === '/api/browse-dirs') {
      const bad = rejectRead(req); if (bad) return sendJSON(res, bad.code, { error: bad.error })
      const raw = String(url.searchParams.get('path') || '').trim() || homedir()
      const deadline = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 2000))
      try {
        const real = await Promise.race([realpathP(expandHome(raw)), deadline])
        const st = await Promise.race([statP(real), deadline])
        if (!st.isDirectory()) throw new Error('enotdir')   // collapse not-a-dir INTO the generic error (Pierre): a file → same "cannot open" as nonexistent/EACCES, so a bypass can't tell file-vs-nonexistent-vs-noperm apart (no existence/permission/type oracle). Only timeout (a perf signal, not existence) stays distinct.
        const ents = await Promise.race([readdirP(real, { withFileTypes: true }), deadline])
        const dirs = []
        for (const e of ents) { if (e.isDirectory()) { dirs.push(e.name); if (dirs.length >= 2000) break } }   // real subdirs only — no files, no symlink-following; a dir of only FILES (~/.ssh, a secrets dir) lists EMPTY (never enumerates filenames)
        dirs.sort((a, b) => a.localeCompare(b))
        return sendJSON(res, 200, { ok: true, path: real, parent: real === '/' ? null : dirname(real), dirs, truncated: dirs.length >= 2000 })
      } catch (e) { return sendJSON(res, 200, { ok: false, error: /timed out/.test(String(e?.message)) ? 'timed out' : 'cannot open this folder' }) }
    }
    // #48b: serve a worker-generated IMAGE asset (call-history preview), guarded HARD against path-traversal
    // / symlink-escape. GET (no CSRF — a read, consistent with the other GETs); the path-guard + raster-only
    // ext allowlist IS the security. Fails CLOSED on every error with NO body detail (don't leak file existence).
    if (req.method === 'GET' && url.pathname === '/api/asset') {
      const rel = url.searchParams.get('path') || ''                 // URLSearchParams decodes exactly once
      const ext = extname(rel).toLowerCase()
      const deny = (code = 404) => { res.writeHead(code, { 'cache-control': 'no-store' }); res.end() }
      if (!ASSET_CONTENT_TYPES[ext]) return deny(415)                // allowlisted media only — raster images + mp3 (no svg/.env/source)
      const gr = await ctrl(daemonMeta()?.controlPort, 'getroster', { org: url.searchParams.get('org') })
      const repo = gr?.repo
      if (!repo) return deny()                                       // unknown org → 404, no detail
      const file = safeAssetPath(repo, rel)
      if (!file) return deny()                                       // escaped the repo / unsafe path
      let st; try { st = statSync(file) } catch { return deny() }
      if (!st.isFile()) return deny()
      if (st.size > 25 * 1024 * 1024) return deny(413)               // size cap BEFORE read
      let buf; try { buf = readFileSync(file) } catch { return deny() }
      res.writeHead(200, { 'content-type': ASSET_CONTENT_TYPES[ext], 'content-length': buf.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      return res.end(buf)
    }
    // #42: the persona palette for the editor + builder role-chooser — read-only built-in role defs +
    // this org's custom personas (read from its team.json on disk, the authoritative source).
    if (req.method === 'GET' && url.pathname === '/api/personas') {
      const builtin = Object.entries(ROLES).map(([key, d]) => ({ key, label: d.label, mandate: d.mandate, mount: d.mount, tier: d.tier, leadByDefault: !!d.leadByDefault, media: isMediaRole(key) }))
      const gr = await ctrl(daemonMeta()?.controlPort, 'getroster', { org: url.searchParams.get('org') })
      const repo = gr?.repo || null
      let custom = {}
      if (repo) { try { const tj = JSON.parse(readFileSync(join(repo, 'team.json'), 'utf8')); if (tj.personas && typeof tj.personas === 'object' && !Array.isArray(tj.personas)) custom = tj.personas } catch {} }
      return sendJSON(res, 200, { ok: true, builtin, custom, repo })
    }
    // #42 chunk C: Settings — surface the env/localStorage-only knobs, each tagged scope + mutability.
    // #44: the name-style pools for the builder's member-naming — single source (no client-side dup).
    if (req.method === 'GET' && url.pathname === '/api/names') {
      return sendJSON(res, 200, { ok: true, styles: NAME_STYLE_NAMES, pools: NAME_STYLES })
    }
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const gp = await ctrl(daemonMeta()?.controlPort, 'getprefs')
      const np = (gp?.prefs || {}).notify || {}
      const notify = { chime: np.chime !== false, questions: np.questions !== false, fyis: np.fyis !== false }   // all default ON (preserve prior behavior; both types notify, questions chime)
      return sendJSON(res, 200, { ok: true,
        turnCap: { value: gp?.turnCap ?? null, env: gp?.envTurnCap ?? '', scope: 'global', mutability: 'runtime' },
        notify: { value: notify, scope: 'global', mutability: 'runtime' },
        dashboardPort: { value: DASH_PORT || Number(process.env.MRC_DASHBOARD_PORT) || 8787, scope: 'global', mutability: 'launch' },
        web: { scope: 'project', mutability: 'launch', note: 'outbound egress is the per-launch --web flag (off by default) — change it by relaunching with/without --web' },
      })
    }
    if (req.method === 'GET' && url.pathname === '/api/worker-log') {
      const meta = daemonMeta()
      const r = meta?.controlPort ? await ctrl(meta.controlPort, 'workerlog', { handle: url.searchParams.get('handle'), org: url.searchParams.get('org') || undefined }) : { ok: false }
      return sendJSON(res, 200, r)
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const meta = daemonMeta()
      const r = meta?.controlPort ? await ctrl(meta.controlPort, 'sessions') : { ok: false }
      return sendJSON(res, 200, r?.ok ? r : { ok: false, sessions: [] })
    }
    // #69-B: the SSE delta stream — replaces the dashboard's full-payload poll. Origin-gated (DNS-rebinding read
    // control, MANDATORY — it carries continuous room state). The daemon's delta bus (wired in startDashboard)
    // writes server-sent events to every client in `sseClients`; read-push only, no client write path.
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const bad = rejectRead(req); if (bad) { res.writeHead(bad.code, { 'cache-control': 'no-store' }); return res.end() }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write('retry: 3000\n\n')                                  // EventSource auto-reconnect backoff hint
      sseClients.add(res)
      const hb = setInterval(() => { try { res.write(': hb\n\n') } catch {} }, 25000)   // heartbeat so proxies/idle don't drop the stream
      req.on('close', () => { clearInterval(hb); sseClients.delete(res) })
      return
    }
    // #69-B defense-in-depth: the heavy state reads carry bulk room state → origin-gate them too (closes the
    // read-vs-POST DNS-rebinding asymmetry; the legit same-origin dashboard passes 127.0.0.1→127.0.0.1).
    if (req.method === 'GET' && url.pathname === '/api/state') { const bad = rejectRead(req); if (bad) return sendJSON(res, bad.code, { error: bad.error }); return sendJSONCached(req, res, await buildState()) }   // #69-A ETag/304
    if (req.method === 'GET' && url.pathname === '/api/teams') {
      const bad = rejectRead(req); if (bad) return sendJSON(res, bad.code, { error: bad.error })
      const meta = daemonMeta()
      const t = meta?.controlPort ? await ctrl(meta.controlPort, 'team') : { ok: false }
      return sendJSONCached(req, res, t?.ok ? t : { ok: false, members: [], rooms: [], userInbox: [] })   // #69-A: the 277 KB poll read → ETag/304
    }
    if (req.method === 'GET' && url.pathname === '/api/room') {
      const id = url.searchParams.get('id')
      if (!knownRoom(id)) return sendJSON(res, 404, { error: 'unknown room' })
      const dir = roomDir(id)
      let meta = {}; try { meta = JSON.parse(readIf(join(dir, 'room.json'))) } catch {}
      return sendJSON(res, 200, { roomId: id, meta, thread: readIf(join(dir, 'thread.log')), transcript: readTranscript(id), consensus: readIf(join(dir, 'consensus.md')), catchups: readCatchups(id) })
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}') } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }) }
        if (!['brake', 'resume', 'steer', 'end', 'review', 'catchup', 'autocatchup', 'answer', 'dismiss', 'reopen'].includes(j.action)) return sendJSON(res, 400, { ok: false, error: 'action not allowed' })
        if (j.roomId && !knownRoom(j.roomId)) return sendJSON(res, 404, { ok: false, error: 'unknown room' })
        // 'review' is a local catchups.json write (we run inside the daemon process), not a control action.
        if (j.action === 'review') {
          const e = updateCatchup(j.roomId, Number(j.seq), { reviewedAt: new Date().toISOString() })
          return sendJSON(res, 200, e ? { ok: true } : { ok: false, error: 'unknown catch-up' })
        }
        // 'answer' replies to an @user inbox item; no roomId (the daemon knows the item's room). It routes a
        // TRUSTED [Human reply] → capOk-gated on the daemon (steer's twin, Pierre), so thread the 0600 secret.
        if (j.action === 'answer') return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'answer', { i: Number(j.i), text: String(j.text || '').slice(0, 8000), secret: controlSecret() }))
        // 'dismiss' clears an @user inbox item without replying (#11); 'reopen' undoes a dismiss. (capOk-gated for consistency.)
        if (j.action === 'dismiss') return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'dismiss', { i: Number(j.i), secret: controlSecret() }))
        if (j.action === 'reopen') return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'reopen', { i: Number(j.i), secret: controlSecret() }))
        const extra = { roomId: j.roomId }
        // Team rooms steer by member handle / role / 'all'; legacy pairings use a|b|both (non-a/b => both).
        if (j.action === 'steer') { extra.target = String(j.target || 'both').slice(0, 80); extra.text = String(j.text || '').slice(0, 8000) }
        if (j.action === 'autocatchup') extra.on = !!j.on
        // brake/resume/steer/end are now capOk-gated on the daemon (steer injects a trusted [Human directive] — a
        // cross-uid host process on the TCP control port must NOT forge it). This layer runs in the daemon's uid,
        // so it reads the host-only 0600 control-secret and forwards it — same as the team-* doors (:337+). Without
        // this the daemon would 403 the legitimate dashboard steer.
        if (['brake', 'resume', 'steer', 'end'].includes(j.action)) extra.secret = controlSecret()
        return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, j.action, extra))
      })
      return
    }
    // Catch-all: any non-API GET (/, /anigame, …) serves the single-page app, which reads the project
    // from the path. Re-read the file each load so the page can be edited live.
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      // Embed the per-daemon CSRF token; the SPA reads it and sends it as X-MRC-Token on every POST.
      // #63-A: inject the audited safe-md module in <head> (before the body script defines/uses esc/safeMD).
      const html = readFileSync(HTML_FILE, 'utf8').replace('</head>',
        `<meta name="mrc-token" content="${DASH_TOKEN}">\n<script>\n${safeMdInline()}\n</script>\n</head>`)
      return res.end(html)
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  } catch (e) {
    sendJSON(res, 500, { error: String(e?.message || e) })
  }
}

export async function startDashboard({ port, onActivity, subscribe } = {}) {
  if (!existsSync(roomsRoot())) { /* no rooms yet — the page will just show an empty list */ }
  const base = port || Number(process.env.MRC_DASHBOARD_PORT) || 8787
  const free = await findFreePort(base)
  // Remember our bound port, then load (or first-time mint) the persisted CSRF token (#20): reusing it
  // across restarts means an already-open tab's next POST still validates instead of silently 403'ing.
  DASH_PORT = free
  DASH_TOKEN = loadOrMintToken()
  // #69-B: fan the daemon's in-process delta bus out to every connected SSE client (read-push; server→client only).
  if (typeof subscribe === 'function' && !SSE_WIRED) {
    SSE_WIRED = true
    subscribe((ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const r of sseClients) { try { r.write(line) } catch {} } })
  }
  // onActivity fires per request; the daemon uses it as a keep-alive so an open dashboard
  // prevents idle-shutdown (you won't lose the view mid-browse).
  const server = http.createServer((req, res) => { try { onActivity?.() } catch {} handle(req, res) })
  server.on('upgrade', (req, socket, head) => { try { onActivity?.() } catch {} proxyTtydUpgrade(req, socket, head) })   // guard-4: WS terminal proxy (separate handler — a request-handler gate would be bypassed here)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(free, '127.0.0.1', resolve) })
  return { server, port: free, url: `http://127.0.0.1:${free}/` }
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref() } catch {}
}
