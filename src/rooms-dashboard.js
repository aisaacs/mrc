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
import { roomsRoot, roomDir, listRooms, readCatchups, updateCatchup, readTranscript, atomicWriteFileSync } from './rooms.js'
import { findFreePort } from './ports.js'
import { parseRoster, validateRoster, editPersona } from './teams/roster.js'
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    // Gate EVERY state-changing request (all POSTs are state-changers; reads are GET) on the token +
    // same-origin/host, before consuming the body → a fast, side-effect-free 403 for forged requests.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const bad = rejectStateChange(req)
      if (bad) return sendJSON(res, bad.code, { ok: false, error: bad.error })
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
        return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'defineOrg', { def, roster: j.roster }))
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
    if (req.method === 'POST' && (url.pathname === '/api/team-launch' || url.pathname === '/api/team-stop' || url.pathname === '/api/team-delete' || url.pathname === '/api/team-add-member' || url.pathname === '/api/team-remove-member' || url.pathname === '/api/team-relaunch-member' || url.pathname === '/api/kill-session')) {
      let body = ''
      req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy() })
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}') } catch { return sendJSON(res, 400, { ok: false, error: 'bad json' }) }
        const cp = daemonMeta()?.controlPort
        if (url.pathname === '/api/team-launch') return sendJSON(res, 200, await ctrl(cp, 'launchteam', { roster: j.roster, org: j.org, repo: j.repo }))
        if (url.pathname === '/api/team-stop') return sendJSON(res, 200, await ctrl(cp, 'stopteam', { org: j.org }))
        if (url.pathname === '/api/team-delete') return sendJSON(res, 200, await ctrl(cp, 'removeorg', { org: j.org }))   // #13: forget the project (no disk deletion)
        if (url.pathname === '/api/team-add-member') return sendJSON(res, 200, await ctrl(cp, 'addmember', { org: j.org, team: j.team, role: j.role, backend: j.backend, territory: j.territory }))
        if (url.pathname === '/api/team-remove-member') return sendJSON(res, 200, await ctrl(cp, 'removemember', { org: j.org, handle: j.handle }))
        if (url.pathname === '/api/team-relaunch-member') return sendJSON(res, 200, await ctrl(cp, 'relaunchmember', { org: j.org, handle: j.handle }))   // #41: orphan recovery (kill-first → respawn)
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
        // 'answer' replies to an @user inbox item; no roomId (the daemon knows the item's room).
        if (j.action === 'answer') return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'answer', { i: Number(j.i), text: String(j.text || '').slice(0, 8000) }))
        // 'dismiss' clears an @user inbox item without replying (#11); 'reopen' undoes a dismiss.
        if (j.action === 'dismiss') return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'dismiss', { i: Number(j.i) }))
        if (j.action === 'reopen') return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'reopen', { i: Number(j.i) }))
        const extra = { roomId: j.roomId }
        // Team rooms steer by member handle / role / 'all'; legacy pairings use a|b|both (non-a/b => both).
        if (j.action === 'steer') { extra.target = String(j.target || 'both').slice(0, 80); extra.text = String(j.text || '').slice(0, 8000) }
        if (j.action === 'autocatchup') extra.on = !!j.on
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
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(free, '127.0.0.1', resolve) })
  return { server, port: free, url: `http://127.0.0.1:${free}/` }
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref() } catch {}
}
