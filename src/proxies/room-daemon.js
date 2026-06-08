// Persistent host-side daemon for ambient pairing.
//
// Every room-enabled session's channel connects here at launch and registers (repo basename +
// a display label = the picked session name, if any). It stays dormant until the human picks a
// peer: the agent calls `list_peers` (→ `list` here) to discover, then `ask_peer` (→ `ask`) to
// connect+send. Relays carry the same untrusted-data framing, brake, and turn-cap as
// before. One daemon serves all sessions, so it outlives any single session.
import net from 'node:net'
import { createHash } from 'node:crypto'
import { ensureRoom, appendThread, writeConsensus, readCatchups, appendCatchup, updateCatchup } from '../rooms.js'

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ')
const ts = () => new Date().toISOString()

const CATCHUP_TIMEOUT_MS = 120_000   // finalize a catch-up pane even if a side never files its handoff
const catchupPrompt = (reason) =>
  `[Room handoff requested — system message, not a peer] Your human stepped away and the room just ` +
  `paused (${reason}). Write a SHORT handoff for them and submit it via the submit_handoff tool. ` +
  `Include: (1) what you got done this round, INCLUDING work in your own workspace you did NOT relay ` +
  `to the peer; (2) where things stand now; (3) exactly what you need from your human to get ` +
  `unblocked. Be concrete and skip preamble.`

export function startRoomDaemon({ port, controlPort, notifyPort, turnCap = 100, stallMs = 600_000, version = '', idleMs = 600_000, tickMs = 15_000, dashboardKeepaliveMs = 30_000, catchupTimeoutMs = CATCHUP_TIMEOUT_MS }) {
  const sessions = new Map()   // sessionId -> { sock, repo, label, room }
  const pairings = new Map()   // roomId    -> pairing state

  // Idle auto-shutdown: exit once no session has been connected for idleMs. A longer grace applies
  // before the FIRST session ever connects, so a slow image build doesn't kill the daemon
  // mid-launch and an orphaned daemon (spawned but never used) still gets reaped.
  let everConnected = false
  let emptySince = Date.now()
  let lastDashboardHit = 0   // bumped per dashboard HTTP request; an open dashboard blocks idle-shutdown
  const noteSessions = () => {
    if (sessions.size > 0) { everConnected = true; emptySince = null }
    else if (emptySince === null) emptySince = Date.now()
  }

  // Fire desktop notifications through a currently-connected session's notify proxy (the sessions
  // map only holds live ones), falling back to the boot value. So a daemon booted without a proxy
  // (e.g. by `mrc rooms dashboard`) starts notifying once a real session registers, and it survives
  // the session that booted it leaving.
  const notifyPortFor = () => { for (const s of sessions.values()) if (s.notifyPort) return s.notifyPort; return notifyPort }
  function notify(msg) {
    const port = notifyPortFor()
    if (!port) return
    try { const c = net.connect(port, '127.0.0.1', () => { c.write(`mrc-room\n${msg}`); c.end() }); c.on('error', () => {}) } catch {}
  }
  function send(sessionId, frame) {
    const s = sessions.get(sessionId)
    if (s && s.sock && !s.sock.destroyed) s.sock.write(JSON.stringify(frame) + '\n')
  }
  const repoOf = (id) => sessions.get(id)?.repo || '?'                       // basename — for clean room ids
  const nameOf = (id) => { const s = sessions.get(id); return s ? (s.label || s.repo) : '?' }  // display / match
  function pairingFor(id) { for (const p of pairings.values()) if (p.a === id || p.b === id) return p; return null }

  function peerList(exceptId) {
    const raw = [...sessions.keys()].filter((id) => id !== exceptId).map((id) => ({ name: nameOf(id), repo: repoOf(id), id }))
    // Give each peer a UNIQUE display handle so identical names (e.g. two unnamed sessions in the
    // same repo) stay individually addressable instead of collapsing into one ambiguous string.
    const counts = {}
    for (const p of raw) { const k = p.name.toLowerCase(); counts[k] = (counts[k] || 0) + 1 }
    for (const p of raw) p.display = counts[p.name.toLowerCase()] > 1 ? `${p.name} [${p.id.slice(-6)}]` : p.name
    return raw
  }

  // Resolve which connected session a session wants to talk to. Match MOST-SPECIFIC first so an
  // exact name/handle wins over a loose substring — otherwise a hint that happens to be a repo name
  // (shared by several sessions) substring-matches them all and the session becomes unaddressable.
  function resolvePeer(askerId, hint) {
    const others = peerList(askerId)
    if (others.length === 0) return { none: true }
    const h = norm(hint).toLowerCase()
    if (h) {
      const tiers = [
        others.filter((o) => o.id === hint),                                   // exact session id
        others.filter((o) => (o.display || o.name).toLowerCase() === h),       // exact display handle
        others.filter((o) => o.name.toLowerCase() === h),                      // exact name
        others.filter((o) => o.name.toLowerCase().includes(h)),                // name substring
        others.filter((o) => `${o.name} ${o.repo}`.toLowerCase().includes(h)), // name+repo substring (loosest)
      ]
      for (const m of tiers) {
        if (m.length === 1) return { peer: m[0] }
        if (m.length > 1) return { ambiguous: m }
      }
    }
    if (others.length === 1) return { peer: others[0] }
    return { ambiguous: others }
  }

  // Room id. A NAMED room uses the (shared) name verbatim — two sessions that pass the same
  // --room name pair deterministically, so you can deliberately join a room by knowing its id.
  // An AMBIENT pairing derives its id from the two SESSION ids (unique per launch), NOT their human
  // labels: labels collide (e.g. two sessions in the same repo) and would reuse a stale room's
  // consensus/thread. A readable label prefix is kept for the dir name; the hash of the exact id
  // pair makes the room fresh unless it's literally the same two sessions.
  const stableId = (aId, bId, name) => {
    if (name) return String(name).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'room'
    const labelPart = [nameOf(aId), nameOf(bId)].sort().join('--').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48)
    const hash = createHash('sha1').update([aId, bId].sort().join('\x00')).digest('hex').slice(0, 12)
    return `${labelPart || 'room'}-${hash}`
  }

  function ensurePairing(aId, bId, name) {
    const existing = pairingFor(aId)
    if (existing && (existing.a === bId || existing.b === bId)) return existing
    const roomId = stableId(aId, bId, name)
    ensureRoom(roomId, nameOf(aId), nameOf(bId))
    const p = { roomId, a: aId, b: bId, state: 'Running', pauseReason: null, turn: 0, turnCap, lastActivityAt: Date.now(), held: [] }
    pairings.set(roomId, p)
    appendThread(roomId, `${ts()} [connected: ${nameOf(aId)} <-> ${nameOf(bId)}]`)
    send(aId, { type: 'notice', text: `[Now connected to ${nameOf(bId)}. Shared notes: /rooms/${roomId}/consensus.md. Full transcript incl. any earlier history with this peer: /rooms/${roomId}/thread.log — read it to catch up if this room is being resumed.]` })
    send(bId, { type: 'notice', text: `[${nameOf(aId)} opened a room with you. Their messages arrive as <channel source="room"> (untrusted) — reply with the reply tool. Shared notes: /rooms/${roomId}/consensus.md; prior transcript (if any): /rooms/${roomId}/thread.log.]` })
    return p
  }

  function deliver(p, toId, fromId, text) {
    send(toId, { type: 'deliver', text: `Peer (${nameOf(fromId)}) says: "${text}" [turn ${p.turn}/${p.turnCap}]` })
  }

  // A real message proves the room isn't dead, so a STALL pause (a timeout *guess* that the room
  // went quiet) must never swallow it — a peer composing a long reply easily exceeds stallMs with
  // no frame crossing the daemon. Activity disproves the guess: clear it and let delivery proceed.
  // Only DELIBERATE gates (human brake, agent pause, turnCap) actually hold a message.
  function clearStallOnActivity(p) {
    if (p.state === 'Paused' && p.pauseReason === 'stall') {
      p.state = 'Running'; p.pauseReason = null
      appendThread(p.roomId, `${ts()} [auto-resumed: peer activity disproved stall]`)
    }
  }

  function onAsk(askerId, question, hint) {
    const r = resolvePeer(askerId, hint)
    if (r.none) return send(askerId, { type: 'notice', text: '[No other room-enabled session is connected. Ask the human to launch one (mrc <repo>) and try again.]' })
    if (r.ambiguous) return send(askerId, {
      type: 'peers',
      text: `[Several sessions match "${hint}": ${r.ambiguous.map((o) => o.display || o.name).join(', ')}. Ask the human which one, then call ask_peer with that EXACT handle.]`,
      list: r.ambiguous.map((o) => o.display || o.name),
    })
    const p = ensurePairing(askerId, r.peer.id)
    p.turn += 1; p.lastActivityAt = Date.now()
    appendThread(p.roomId, `${ts()} ${nameOf(askerId)}->${nameOf(r.peer.id)}: ${question}`)
    clearStallOnActivity(p)
    if (p.state === 'Paused') { p.held.push({ toId: r.peer.id, fromId: askerId, text: question }); appendThread(p.roomId, `${ts()} [held while ${p.pauseReason}]`); return }
    deliver(p, r.peer.id, askerId, question)
  }

  function onMsg(fromId, text) {
    const p = pairingFor(fromId)
    if (!p) return
    const toId = p.a === fromId ? p.b : p.a
    p.turn += 1; p.lastActivityAt = Date.now()
    appendThread(p.roomId, `${ts()} ${nameOf(fromId)}->${nameOf(toId)}: ${text}`)
    clearStallOnActivity(p)
    if (p.state === 'Paused') { p.held.push({ toId, fromId, text }); appendThread(p.roomId, `${ts()} [held while ${p.pauseReason}]`); return }
    deliver(p, toId, fromId, text)
    if (p.turnCap > 0 && p.turn >= p.turnCap) { p.state = 'Paused'; p.pauseReason = 'turnCap'; notify(`Room ${p.roomId}: turn-cap check-in at ${p.turn} (resume to grant ${turnCap} more)`); elicitCatchup(p, 'turnCap') }
  }

  // Shared running summary: either side may refresh consensus.md at any time. It's living notes,
  // not a signed gate — no matching, no pause; the room stays open until the human ends it.
  function onNote(fromId, text) {
    const p = pairingFor(fromId)
    if (!p) return
    writeConsensus(p.roomId, text)
    appendThread(p.roomId, `${ts()} [${nameOf(fromId)} updated the shared summary]`)
  }

  // --- catch-up panes: at an autonomous pause, ask each live side for a handoff for the human. The
  // working agent (not a transcript summarizer) writes it, so off-log context — its own repo work,
  // reasoning, the real blocker — makes it in. Captured per-pause into the room's catchups.json.
  function elicitCatchup(p, reason, { manual = false } = {}) {
    const live = [['a', p.a], ['b', p.b]].filter(([, id]) => sessions.has(id))
    if (!live.length) return { ok: false, error: 'no live sessions to ask' }
    if (p.pendingCatchup) {
      if (!manual) return { ok: false, error: 'catch-up already pending' }
      // Manual re-trigger while a pane is still filling: re-ask only the sides that haven't filed
      // (e.g. one was busy with the human's own work when the first request arrived).
      const e = readCatchups(p.roomId).find((x) => x.seq === p.pendingCatchup)
      const missing = live.filter(([role]) => !(e && e.handoffs && e.handoffs[role]))
      for (const [, id] of missing) send(id, { type: 'catchup_request', text: catchupPrompt(reason) })
      appendThread(p.roomId, `${ts()} [catch-up re-request] (${reason}) -> ${missing.map(([, id]) => nameOf(id)).join(', ') || '(none missing)'}\n${catchupPrompt(reason)}`)
      return { ok: true, seq: p.pendingCatchup, nudged: missing.length }
    }
    const seq = appendCatchup(p.roomId, { ts: ts(), pauseReason: reason, status: 'pending', expected: live.length, handoffs: {} })
    p.pendingCatchup = seq
    for (const [, id] of live) send(id, { type: 'catchup_request', text: catchupPrompt(reason) })
    appendThread(p.roomId, `${ts()} [catch-up request] (${reason}) -> ${live.map(([, id]) => nameOf(id)).join(', ')}\n${catchupPrompt(reason)}`)
    setTimeout(() => {
      const e = readCatchups(p.roomId).find((x) => x.seq === seq)
      if (e && e.status === 'pending') updateCatchup(p.roomId, seq, { status: 'ready' })
      if (p.pendingCatchup === seq) p.pendingCatchup = null
    }, catchupTimeoutMs)
    return { ok: true, seq }
  }
  function onHandoff(fromId, text) {
    const p = pairingFor(fromId); if (!p) return
    const role = p.a === fromId ? 'a' : 'b'
    const list = readCatchups(p.roomId)
    // Prefer the pane we're actively gathering; else fall back to the most recent un-reviewed pane
    // still missing THIS side — so a side that files late (it was mid-task when the request arrived,
    // after the pane already timed out) still lands instead of being dropped.
    let e = p.pendingCatchup ? list.find((x) => x.seq === p.pendingCatchup) : null
    if (!e) for (let i = list.length - 1; i >= 0; i--) { const x = list[i]; if (!x.reviewedAt && !(x.handoffs && x.handoffs[role])) { e = x; break } }
    if (!e) return
    e.handoffs = e.handoffs || {}
    e.handoffs[role] = { name: nameOf(fromId), text: String(text || '') }
    if (Object.keys(e.handoffs).length >= (e.expected || 1)) { e.status = 'ready'; if (p.pendingCatchup === e.seq) p.pendingCatchup = null }
    updateCatchup(p.roomId, e.seq, { handoffs: e.handoffs, status: e.status })
    // Durably capture the FULL handoff in the canonical audit log too (panes can be edited/dropped;
    // thread.log is append-only). The dashboard display-makes the `[handoff]` prefix into a card.
    appendThread(p.roomId, `${ts()} [handoff] ${nameOf(fromId)} -> human\n${String(text || '')}`)
  }

  function doBrake(p, reason = 'brake') {
    p.state = 'Paused'; p.pauseReason = reason; appendThread(p.roomId, `${ts()} [paused: ${reason}]`)
    return p.held.length ? p.held.map((h) => h.text).join(' / ') : null   // pending queued message(s), for the human
  }
  function doResume(p) {
    // A turn-cap pause is a periodic check-in, not a wall: resuming grants another full window so a
    // long-running consult channel doesn't re-pause on the very next message.
    if (p.pauseReason === 'turnCap' && turnCap > 0) p.turnCap = p.turn + turnCap
    // Deliver the FULL backlog in arrival order — held is a FIFO queue, so a brake that spanned
    // several messages no longer drops all but the last one on resume.
    const queued = p.held; p.held = []
    for (const h of queued) deliver(p, h.toId, h.fromId, h.text)
    p.state = 'Running'; p.pauseReason = null; p.lastActivityAt = Date.now()
    appendThread(p.roomId, `${ts()} [resumed${queued.length ? `: delivered ${queued.length} held` : ''}]`)
  }
  // Agent-initiated pause/resume: the human tells their own session "pause"/"resume" and the
  // channel server relays it here. Closing a room is deliberately NOT an agent power — only the
  // human, via `mrc rooms end`.
  function onAgentPause(sessionId) {
    const p = pairingFor(sessionId)
    if (!p) return send(sessionId, { type: 'notice', text: '[No active room to pause.]' })
    doBrake(p, 'brake'); notify(`Room ${p.roomId}: paused (agent)`)
    send(sessionId, { type: 'notice', text: '[Room paused — relaying is held. Say "resume" to continue; closing is the human via `mrc rooms end`.]' })
  }
  function onAgentResume(sessionId) {
    const p = pairingFor(sessionId)
    if (!p) return send(sessionId, { type: 'notice', text: '[No active room to resume.]' })
    doResume(p); send(sessionId, { type: 'notice', text: '[Room resumed.]' })
  }

  // --- relay server (channel servers connect here) ---
  const server = net.createServer((sock) => {
    let buf = '', sessionId = null
    sock.on('data', (d) => {
      buf += d; let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue
        let f; try { f = JSON.parse(line) } catch { continue }
        if (f.type === 'register' && f.sessionId) {
          sessionId = f.sessionId
          sessions.set(sessionId, { sock, repo: f.repo || '?', label: f.label || f.repo || '?', room: f.room || null, notifyPort: Number(f.notifyPort) || 0 })
          noteSessions()
          if (f.room) {  // explicit named room: auto-pair with another session of the same name
            for (const [oid, ov] of sessions) {
              if (oid !== sessionId && ov.room === f.room && !pairingFor(oid)) { ensurePairing(sessionId, oid, f.room); break }
            }
          }
        } else if (f.type === 'list' && sessionId) {
          send(sessionId, { type: 'peerlist', peers: peerList(sessionId) })
        } else if (f.type === 'ask' && sessionId) onAsk(sessionId, String(f.question ?? ''), f.peer)
        else if (f.type === 'msg' && sessionId) onMsg(sessionId, String(f.text ?? ''))
        else if (f.type === 'note' && sessionId) onNote(sessionId, String(f.text ?? ''))
        else if (f.type === 'handoff' && sessionId) onHandoff(sessionId, String(f.text ?? ''))
        else if (f.type === 'pause' && sessionId) onAgentPause(sessionId)
        else if (f.type === 'resume' && sessionId) onAgentResume(sessionId)
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => { if (sessionId) { sessions.delete(sessionId); noteSessions() } })
  })
  server.listen(port, '127.0.0.1')
  server.on('error', () => process.exit(1))   // e.g. EADDRINUSE on an in-place restart → let the caller fall back

  // --- control server (`mrc rooms` connects here) ---
  const pick = (roomId) => roomId ? pairings.get(roomId) : (pairings.size === 1 ? [...pairings.values()][0] : null)
  const control = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d; let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue
        let f; try { f = JSON.parse(line) } catch { continue }
        const reply = (o) => { try { sock.write(JSON.stringify(o) + '\n') } catch {} }
        if (f.action === 'status') {
          reply({
            ok: true,
            version,
            sessions: [...sessions.entries()].map(([id, v]) => ({ id, repo: v.repo, name: v.label || v.repo })),
            pairings: [...pairings.values()].map((p) => ({ roomId: p.roomId, state: p.state, pauseReason: p.pauseReason, turn: p.turn, turnCap: p.turnCap, a: nameOf(p.a), b: nameOf(p.b) })),
          })
          continue
        }
        if (f.action === 'shutdown') {   // graceful stop (used by `mrc rooms restart` / version refresh)
          reply({ ok: true })
          setTimeout(() => { try { server.close(); control.close() } catch {} ; process.exit(0) }, 50)
          continue
        }
        const p = pick(f.roomId)
        if (!p) { reply({ ok: false, error: f.roomId ? `no open room "${f.roomId}" (see: mrc rooms status)` : (pairings.size ? 'multiple rooms open — pass a room id (see: mrc rooms status)' : 'no open room') }); continue }
        switch (f.action) {
          case 'brake': reply({ ok: true, held: doBrake(p, 'brake') }); break
          case 'resume': doResume(p); reply({ ok: true }); break
          case 'catchup': reply(elicitCatchup(p, 'requested', { manual: true })); break
          case 'steer': {
            const targets = f.target === 'a' ? [p.a] : f.target === 'b' ? [p.b] : [p.a, p.b]
            for (const t of targets) send(t, { type: 'directive', text: `[Human directive]: ${f.text}` })
            // Steering is a deliberate human override of the conversation's direction, so the held
            // backlog is intentionally dropped (not delivered) — but log how much, so it's traceable.
            if (p.pauseReason === 'turnCap' && turnCap > 0) p.turnCap = p.turn + turnCap
            if (p.held.length) appendThread(p.roomId, `${ts()} [steer dropped ${p.held.length} held]`)
            p.held = []; p.state = 'Running'; p.pauseReason = null; p.lastActivityAt = Date.now()
            appendThread(p.roomId, `${ts()} HUMAN->${f.target || 'both'}: ${f.text}`); reply({ ok: true }); break
          }
          case 'end': {
            const note = '[Room closed. The transcript and consensus.md are preserved on disk.]'
            send(p.a, { type: 'notice', text: note }); send(p.b, { type: 'notice', text: note })
            appendThread(p.roomId, `${ts()} [closed]`); pairings.delete(p.roomId); reply({ ok: true }); break
          }
          default: reply({ ok: false, error: 'unknown action' })
        }
      }
    })
    sock.on('error', () => {})
  })
  control.listen(controlPort, '127.0.0.1')
  control.on('error', () => process.exit(1))

  const stallTimer = setInterval(() => {
    for (const p of pairings.values()) {
      if (p.state === 'Running' && sessions.has(p.a) && sessions.has(p.b) && Date.now() - p.lastActivityAt > stallMs) {
        // Soft, self-healing pause: flag a quiet room for the human, but the next real message
        // auto-resumes (clearStallOnActivity) so a slow-but-alive peer is never swallowed.
        p.state = 'Paused'; p.pauseReason = 'stall'
        appendThread(p.roomId, `${ts()} [paused: stall (${Math.round((Date.now() - p.lastActivityAt) / 1000)}s idle)]`)
        notify(`Room ${p.roomId}: paused (stall)`)
        elicitCatchup(p, 'stall')
      }
    }
    // Idle auto-shutdown: exit after idleMs with zero connected sessions (longer grace until the
    // first session ever connects, so a slow image build doesn't kill the daemon mid-launch). An
    // open dashboard counts as activity, so the daemon never quits out from under someone watching.
    const idleGrace = everConnected ? idleMs : Math.max(idleMs, 1_800_000)
    if (emptySince !== null && Date.now() - emptySince > idleGrace && Date.now() - lastDashboardHit > dashboardKeepaliveMs) {
      try { server.close(); control.close() } catch {}
      process.exit(0)
    }
  }, tickMs)
  stallTimer.unref?.()

  return { server, control, sessions, pairings, noteDashboardActivity: () => { lastDashboardHit = Date.now() }, stop: () => { clearInterval(stallTimer); try { server.close(); control.close() } catch {} } }
}

// Direct invocation (mrc spawns this detached): node room-daemon.js <port> <controlPort> [notifyPort]
if (import.meta.url === `file://${process.argv[1]}`) {
  const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const { findFreePort } = await import('../ports.js')
  const version = createHash('sha1').update(readFileSync(process.argv[1])).digest('hex').slice(0, 12)
  const port = Number(process.argv[2])
  const controlPort = Number(process.argv[3])
  const notifyPort = Number(process.argv[4]) || 0
  const envCap = process.env.MRC_ROOM_TURN_CAP
  const turnCap = envCap != null && envCap !== '' && Number.isFinite(Number(envCap)) ? Number(envCap) : undefined
  // Serve the dashboard from inside the daemon so it persists without a foreground tab. Port is
  // allocated here so it can be recorded in room-daemon.json (MRC_DASHBOARD_PORT=0 disables it).
  const dashboardPort = process.env.MRC_DASHBOARD_PORT === '0' ? 0 : await findFreePort(Number(process.env.MRC_DASHBOARD_PORT) || 8787)
  const daemon = startRoomDaemon({ port, controlPort, notifyPort, version, turnCap })
  if (dashboardPort) {
    const { startDashboard } = await import('../rooms-dashboard.js')
    startDashboard({ port: dashboardPort, onActivity: daemon.noteDashboardActivity }).catch(() => {})
  }
  const dir = join(homedir(), '.local', 'share', 'mrc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'room-daemon.json'), JSON.stringify({ port, controlPort, notifyPort, dashboardPort, pid: process.pid, version }, null, 2))
  console.log(`mrc room daemon v${version} listening on ${port} (control ${controlPort}${dashboardPort ? `, dashboard ${dashboardPort}` : ''})`)
}
