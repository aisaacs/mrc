// Local web dashboard for negotiation rooms. Host-only, binds to 127.0.0.1. Shows every room's
// thread.log + consensus.md (live and historical, polled in near-real-time) and exposes the
// room-level controls (pause/resume/steer/end) by proxying to the daemon's control socket. No
// external dependencies — http + fs + the existing control protocol. It deliberately cannot post
// into a chat; the only writes are the room controls and marking a catch-up reviewed.
import http from 'node:http'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { roomsRoot, roomDir, listRooms, readCatchups, updateCatchup, readTranscript } from './rooms.js'
import { findFreePort } from './ports.js'
import { parseRoster, validateRoster } from './teams/roster.js'

const metaPath = () => join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json')
const daemonMeta = () => { try { return JSON.parse(readFileSync(metaPath(), 'utf8')) } catch { return null } }
const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
const HTML_FILE = fileURLToPath(new URL('./dashboard.html', import.meta.url))   // unified, teams-first app
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
      live: !!lp,
      state: lp ? lp.state : 'History',
      pauseReason: lp?.pauseReason || null,
      turn: lp?.turn ?? null,
      turnCap: lp?.turnCap ?? null,
      autoCatchup: lp?.autoCatchup ?? true,
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
          try { writeFileSync(file, JSON.stringify(j.roster, null, 2) + '\n') } catch (e) { return sendJSON(res, 500, { ok: false, error: String(e?.message || e) }) }
          return sendJSON(res, 200, { ok: true, path: file })
        }
        // team-define: push the org to the daemon so its rooms exist (does NOT launch containers).
        // Pass the raw roster too, so the daemon can later launch this defined org from the GUI.
        const def = { org: pv.org, repo: pv.repo, members: pv.members, rooms: pv.rooms }
        return sendJSON(res, 200, await ctrl(daemonMeta()?.controlPort, 'defineOrg', { def, roster: j.roster }))
      })
      return
    }
    // GUI launch lifecycle: start the live members (tmux + embeddable ttyd), stop them, or switch the
    // embedded terminal to a given member's window. All proxy to the daemon.
    if (req.method === 'POST' && (url.pathname === '/api/team-launch' || url.pathname === '/api/team-stop' || url.pathname === '/api/team-delete' || url.pathname === '/api/team-select' || url.pathname === '/api/team-add-member' || url.pathname === '/api/team-remove-member' || url.pathname === '/api/kill-session')) {
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
        if (url.pathname === '/api/kill-session') return sendJSON(res, 200, await ctrl(cp, 'killsession', { id: j.id }))
        return sendJSON(res, 200, await ctrl(cp, 'selectwin', { org: j.org, window: j.window }))
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
    if (req.method === 'GET' && url.pathname === '/api/state') return sendJSON(res, 200, await buildState())
    if (req.method === 'GET' && url.pathname === '/api/teams') {
      const meta = daemonMeta()
      const t = meta?.controlPort ? await ctrl(meta.controlPort, 'team') : { ok: false }
      return sendJSON(res, 200, t?.ok ? t : { ok: false, members: [], rooms: [], userInbox: [] })
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
      const html = readFileSync(HTML_FILE, 'utf8').replace('</head>', `<meta name="mrc-token" content="${DASH_TOKEN}">\n</head>`)
      return res.end(html)
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  } catch (e) {
    sendJSON(res, 500, { error: String(e?.message || e) })
  }
}

export async function startDashboard({ port, onActivity } = {}) {
  if (!existsSync(roomsRoot())) { /* no rooms yet — the page will just show an empty list */ }
  const base = port || Number(process.env.MRC_DASHBOARD_PORT) || 8787
  const free = await findFreePort(base)
  // Remember our bound port, then load (or first-time mint) the persisted CSRF token (#20): reusing it
  // across restarts means an already-open tab's next POST still validates instead of silently 403'ing.
  DASH_PORT = free
  DASH_TOKEN = loadOrMintToken()
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
