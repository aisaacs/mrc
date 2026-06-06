// Host-side room broker — the central relay for a negotiation room.
//
// Both session containers' channel servers open a persistent outbound TCP socket to this
// broker (host.docker.internal:<port>, sanctioned by the firewall). The broker relays
// messages between them, owns all room state (Running/Paused, turn count, stall, consensus),
// applies the untrusted-data framing, and writes thread.log / consensus.md. A second
// localhost-only control socket (<port>+1) serves `mrc room` commands.
//
// Modelled on src/proxies/clipboard-proxy.js / notify-proxy.js (in-process net.createServer).
import net from 'node:net'
import { appendThread, writeConsensus } from '../rooms.js'

const other = (r) => (r === 'A' ? 'B' : 'A')
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ')
const ts = () => new Date().toISOString()

export function startRoomBroker(opts) {
  const { port, controlPort, roomId, notifyPort, repos = {}, turnCap = 20, stallMs = 120_000 } = opts

  const state = {
    state: 'Running',          // 'Running' | 'Paused'
    pauseReason: null,         // 'brake' | 'turnCap' | 'stall' | 'consensus'
    turn: 0,
    turnCap,
    lastActivityAt: Date.now(),
    heldMessage: null,         // { toRole, wrapped } buffered while paused
    sides: {
      A: { sock: null, repo: repos.A || 'A', signed: null },
      B: { sock: null, repo: repos.B || 'B', signed: null },
    },
  }

  function notify(msg) {
    if (!notifyPort) return
    try {
      const c = net.connect(notifyPort, '127.0.0.1', () => { c.write(`mrc-room\nRoom ${roomId}: ${msg}`); c.end() })
      c.on('error', () => {})
    } catch { /* notifications are best-effort */ }
  }

  function sendTo(role, frame) {
    const s = state.sides[role].sock
    if (s && !s.destroyed) s.write(JSON.stringify(frame) + '\n')
  }
  const deliver = (toRole, text, kind = 'deliver') => sendTo(toRole, { type: kind, text })

  function pause(reason) {
    if (state.state === 'Paused') return
    state.state = 'Paused'
    state.pauseReason = reason
    appendThread(roomId, `${ts()} [paused: ${reason}]`)
    if (reason !== 'brake') notify(`paused (${reason})`)
  }

  function onMessage(fromRole, text) {
    const toRole = other(fromRole)
    state.lastActivityAt = Date.now()
    state.turn += 1
    const wrapped = `Peer (${state.sides[fromRole].repo}) says: "${text}" [turn ${state.turn}/${state.turnCap}]`
    appendThread(roomId, `${ts()} ${fromRole}->${toRole}: ${text}`)
    if (state.state === 'Paused') {
      // keep only the most recent held message; log the rest
      if (state.heldMessage) appendThread(roomId, `${ts()} (dropped older held message)`)
      state.heldMessage = { toRole, wrapped }
      appendThread(roomId, `${ts()} ${fromRole}->${toRole} [held while paused]`)
      return
    }
    deliver(toRole, wrapped)
    if (state.turn >= state.turnCap) pause('turnCap')
  }

  function onSign(fromRole, text) {
    state.sides[fromRole].signed = norm(text)
    state.lastActivityAt = Date.now()
    appendThread(roomId, `${ts()} ${fromRole} signed consensus`)
    const a = state.sides.A.signed
    const b = state.sides.B.signed
    if (a && b && a === b) {
      writeConsensus(roomId, text)
      pause('consensus')
      notify('consensus reached — both sides signed matching text')
    } else {
      notify(`${fromRole} proposed a consensus; waiting for the other side`)
      deliver(other(fromRole),
        `Peer proposed a final consensus. If you fully agree, call sign_consensus with the SAME text:\n${text}`,
        'notice')
    }
  }

  // --- relay server: channel servers (containers) connect here ---
  const server = net.createServer((sock) => {
    let buf = ''
    let role = null
    sock.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let f; try { f = JSON.parse(line) } catch { continue }
        if (f.type === 'register' && (f.role === 'A' || f.role === 'B')) {
          role = f.role
          state.sides[role].sock = sock
          if (f.repo) state.sides[role].repo = f.repo
          appendThread(roomId, `${ts()} [${role} connected${f.repo ? ` (${f.repo})` : ''}]`)
        } else if (f.type === 'msg' && role) {
          onMessage(role, String(f.text ?? ''))
        } else if (f.type === 'sign' && role) {
          onSign(role, String(f.text ?? ''))
        }
      }
    })
    sock.on('error', () => {})
    sock.on('close', () => {
      if (role && state.sides[role].sock === sock) {
        state.sides[role].sock = null
        appendThread(roomId, `${ts()} [${role} disconnected]`)
      }
    })
  })
  server.listen(port, '127.0.0.1')

  // --- control server: `mrc room <cmd>` connects here ---
  const control = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (!line.trim()) continue
        let f; try { f = JSON.parse(line) } catch { continue }
        const reply = (o) => { try { sock.write(JSON.stringify(o) + '\n') } catch {} }
        switch (f.action) {
          case 'status':
            reply({
              ok: true, state: state.state, pauseReason: state.pauseReason,
              turn: state.turn, turnCap: state.turnCap,
              held: state.heldMessage ? state.heldMessage.wrapped : null,
              sides: {
                A: { connected: !!state.sides.A.sock, repo: state.sides.A.repo, signed: state.sides.A.signed },
                B: { connected: !!state.sides.B.sock, repo: state.sides.B.repo, signed: state.sides.B.signed },
              },
            })
            break
          case 'brake':
            pause('brake')
            reply({ ok: true, held: state.heldMessage ? state.heldMessage.wrapped : null })
            break
          case 'resume':
            if (state.heldMessage) { deliver(state.heldMessage.toRole, state.heldMessage.wrapped); state.heldMessage = null }
            state.state = 'Running'; state.pauseReason = null; state.lastActivityAt = Date.now()
            appendThread(roomId, `${ts()} [resumed]`)
            reply({ ok: true })
            break
          case 'steer': {
            const tlist = f.target === 'both' ? ['A', 'B'] : (f.target === 'A' || f.target === 'B') ? [f.target] : ['A', 'B']
            for (const t of tlist) deliver(t, `[Human directive]: ${f.text}`, 'directive')
            state.heldMessage = null
            state.state = 'Running'; state.pauseReason = null; state.lastActivityAt = Date.now()
            appendThread(roomId, `${ts()} HUMAN->${tlist.join(',')}: ${f.text}`)
            reply({ ok: true })
            break
          }
          case 'end':
            reply({ ok: true })
            notify('room ended by human')
            appendThread(roomId, `${ts()} [ended]`)
            setTimeout(() => { try { server.close(); control.close() } catch {} ; process.exit(0) }, 200)
            break
          default:
            reply({ ok: false, error: 'unknown action' })
        }
      }
    })
    sock.on('error', () => {})
  })
  control.listen(controlPort, '127.0.0.1')

  // --- stall detector ---
  const stallTimer = setInterval(() => {
    if (state.state === 'Running' && state.sides.A.sock && state.sides.B.sock &&
        Date.now() - state.lastActivityAt > stallMs) {
      pause('stall')
    }
  }, 15_000)
  stallTimer.unref?.()

  return {
    server, control, state,
    stop: () => { clearInterval(stallTimer); try { server.close(); control.close() } catch {} },
  }
}
