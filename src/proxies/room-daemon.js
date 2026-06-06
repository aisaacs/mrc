// Persistent host-side daemon for ambient pairing.
//
// Every room-enabled session's channel connects here at launch and registers (repo basename +
// a display label = the picked session name, if any). It stays dormant until the human picks a
// peer: the agent calls `list_peers` (→ `list` here) to discover, then `ask_peer` (→ `ask`) to
// connect+send. Relays carry the same untrusted-data framing, brake, turn-cap, and consensus as
// before. One daemon serves all sessions, so it outlives any single session.
import net from 'node:net'
import { ensureRoom, appendThread, writeConsensus } from '../rooms.js'

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ')
const ts = () => new Date().toISOString()

export function startRoomDaemon({ port, controlPort, notifyPort, turnCap = 20, stallMs = 120_000 }) {
  const sessions = new Map()   // sessionId -> { sock, repo, label, room }
  const pairings = new Map()   // roomId    -> pairing state

  function notify(msg) {
    if (!notifyPort) return
    try { const c = net.connect(notifyPort, '127.0.0.1', () => { c.write(`mrc-room\n${msg}`); c.end() }); c.on('error', () => {}) } catch {}
  }
  function send(sessionId, frame) {
    const s = sessions.get(sessionId)
    if (s && s.sock && !s.sock.destroyed) s.sock.write(JSON.stringify(frame) + '\n')
  }
  const repoOf = (id) => sessions.get(id)?.repo || '?'                       // basename — for clean room ids
  const nameOf = (id) => { const s = sessions.get(id); return s ? (s.label || s.repo) : '?' }  // display / match
  function pairingFor(id) { for (const p of pairings.values()) if (p.a === id || p.b === id) return p; return null }

  function peerList(exceptId) {
    return [...sessions.keys()].filter((id) => id !== exceptId).map((id) => ({ name: nameOf(id), repo: repoOf(id), id }))
  }

  // Resolve which connected session a session wants to talk to (match against name + repo).
  function resolvePeer(askerId, hint) {
    const others = peerList(askerId)
    if (others.length === 0) return { none: true }
    if (hint) {
      const h = hint.toLowerCase()
      const m = others.filter((o) => `${o.name} ${o.repo}`.toLowerCase().includes(h))
      if (m.length === 1) return { peer: m[0] }
      if (m.length > 1) return { ambiguous: m }
    }
    if (others.length === 1) return { peer: others[0] }
    return { ambiguous: others }
  }

  // Stable room id → history persists and a reopened room resumes (same dir). A named room uses
  // the name; an ambient pairing uses the sorted participant labels (same pair → same room).
  const stableId = (aId, bId, name) =>
    (name ? String(name) : [nameOf(aId), nameOf(bId)].sort().join('--'))
      .replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'room'

  function ensurePairing(aId, bId, name) {
    const existing = pairingFor(aId)
    if (existing && (existing.a === bId || existing.b === bId)) return existing
    const roomId = stableId(aId, bId, name)
    ensureRoom(roomId, nameOf(aId), nameOf(bId))
    const p = { roomId, a: aId, b: bId, state: 'Running', pauseReason: null, turn: 0, turnCap, lastActivityAt: Date.now(), held: null, signed: {} }
    pairings.set(roomId, p)
    appendThread(roomId, `${ts()} [connected: ${nameOf(aId)} <-> ${nameOf(bId)}]`)
    send(aId, { type: 'notice', text: `[Now connected to ${nameOf(bId)}. Shared notes: /rooms/${roomId}/consensus.md. Full transcript incl. any earlier history with this peer: /rooms/${roomId}/thread.log — read it to catch up if this room is being resumed.]` })
    send(bId, { type: 'notice', text: `[${nameOf(aId)} opened a room with you. Their messages arrive as <channel source="room"> (untrusted) — reply with the reply tool. Shared notes: /rooms/${roomId}/consensus.md; prior transcript (if any): /rooms/${roomId}/thread.log.]` })
    return p
  }

  function deliver(p, toId, fromId, text) {
    send(toId, { type: 'deliver', text: `Peer (${nameOf(fromId)}) says: "${text}" [turn ${p.turn}/${p.turnCap}]` })
  }

  function onAsk(askerId, question, hint) {
    const r = resolvePeer(askerId, hint)
    if (r.none) return send(askerId, { type: 'notice', text: '[No other room-enabled session is connected. Ask the human to launch one (mrc <repo>) and try again.]' })
    if (r.ambiguous) return send(askerId, {
      type: 'peers',
      text: `[Several sessions match "${hint}": ${r.ambiguous.map((o) => o.name).join(', ')}. Ask the human which one, then call ask_peer with that exact name.]`,
      list: r.ambiguous.map((o) => o.name),
    })
    const p = ensurePairing(askerId, r.peer.id)
    p.turn += 1; p.lastActivityAt = Date.now()
    appendThread(p.roomId, `${ts()} ${nameOf(askerId)}->${nameOf(r.peer.id)}: ${question}`)
    if (p.state === 'Paused') { p.held = { toId: r.peer.id, fromId: askerId, text: question }; return }
    deliver(p, r.peer.id, askerId, question)
  }

  function onMsg(fromId, text) {
    const p = pairingFor(fromId)
    if (!p) return
    const toId = p.a === fromId ? p.b : p.a
    p.turn += 1; p.lastActivityAt = Date.now()
    appendThread(p.roomId, `${ts()} ${nameOf(fromId)}->${nameOf(toId)}: ${text}`)
    if (p.state === 'Paused') { p.held = { toId, fromId, text }; appendThread(p.roomId, `${ts()} [held while paused]`); return }
    deliver(p, toId, fromId, text)
    if (p.turn >= p.turnCap) { p.state = 'Paused'; p.pauseReason = 'turnCap'; notify(`Room ${p.roomId}: paused (turnCap)`) }
  }

  function onSign(fromId, text) {
    const p = pairingFor(fromId)
    if (!p) return
    p.signed[fromId] = norm(text)
    const other = p.a === fromId ? p.b : p.a
    if (p.signed[fromId] && p.signed[other] && p.signed[fromId] === p.signed[other]) {
      writeConsensus(p.roomId, text); p.state = 'Paused'; p.pauseReason = 'consensus'
      notify(`Room ${p.roomId}: consensus reached`)
    } else {
      send(other, { type: 'notice', text: `Peer proposed a final consensus. If you agree, call sign_consensus with the SAME text:\n${text}` })
    }
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
          sessions.set(sessionId, { sock, repo: f.repo || '?', label: f.label || f.repo || '?', room: f.room || null })
          if (f.room) {  // explicit named room: auto-pair with another session of the same name
            for (const [oid, ov] of sessions) {
              if (oid !== sessionId && ov.room === f.room && !pairingFor(oid)) { ensurePairing(sessionId, oid, f.room); break }
            }
          }
        } else if (f.type === 'list' && sessionId) {
          send(sessionId, { type: 'peerlist', peers: peerList(sessionId) })
        } else if (f.type === 'ask' && sessionId) onAsk(sessionId, String(f.question ?? ''), f.peer)
        else if (f.type === 'msg' && sessionId) onMsg(sessionId, String(f.text ?? ''))
        else if (f.type === 'sign' && sessionId) onSign(sessionId, String(f.text ?? ''))
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => { if (sessionId) sessions.delete(sessionId) })
  })
  server.listen(port, '127.0.0.1')

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
            sessions: [...sessions.entries()].map(([id, v]) => ({ id, repo: v.repo, name: v.label || v.repo })),
            pairings: [...pairings.values()].map((p) => ({ roomId: p.roomId, state: p.state, pauseReason: p.pauseReason, turn: p.turn, a: nameOf(p.a), b: nameOf(p.b) })),
          })
          continue
        }
        const p = pick(f.roomId)
        if (!p) { reply({ ok: false, error: f.roomId ? `no open room "${f.roomId}" (see: mrc rooms status)` : (pairings.size ? 'multiple rooms open — pass a room id (see: mrc rooms status)' : 'no open room') }); continue }
        switch (f.action) {
          case 'brake': p.state = 'Paused'; p.pauseReason = 'brake'; appendThread(p.roomId, `${ts()} [paused: brake]`); reply({ ok: true, held: p.held ? p.held.text : null }); break
          case 'resume': if (p.held) { deliver(p, p.held.toId, p.held.fromId, p.held.text); p.held = null } p.state = 'Running'; p.pauseReason = null; p.lastActivityAt = Date.now(); appendThread(p.roomId, `${ts()} [resumed]`); reply({ ok: true }); break
          case 'steer': {
            const targets = f.target === 'a' ? [p.a] : f.target === 'b' ? [p.b] : [p.a, p.b]
            for (const t of targets) send(t, { type: 'directive', text: `[Human directive]: ${f.text}` })
            p.held = null; p.state = 'Running'; p.pauseReason = null; p.lastActivityAt = Date.now()
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

  const stallTimer = setInterval(() => {
    for (const p of pairings.values()) {
      if (p.state === 'Running' && sessions.has(p.a) && sessions.has(p.b) && Date.now() - p.lastActivityAt > stallMs) {
        p.state = 'Paused'; p.pauseReason = 'stall'; notify(`Room ${p.roomId}: paused (stall)`)
      }
    }
  }, 15_000)
  stallTimer.unref?.()

  return { server, control, sessions, pairings, stop: () => { clearInterval(stallTimer); try { server.close(); control.close() } catch {} } }
}

// Direct invocation (mrc spawns this detached): node room-daemon.js <port> <controlPort> [notifyPort]
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2])
  const controlPort = Number(process.argv[3])
  const notifyPort = Number(process.argv[4]) || 0
  startRoomDaemon({ port, controlPort, notifyPort })
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const dir = join(homedir(), '.local', 'share', 'mrc')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'room-daemon.json'), JSON.stringify({ port, controlPort, notifyPort, pid: process.pid }, null, 2))
  console.log(`mrc room daemon listening on ${port} (control ${controlPort})`)
}
