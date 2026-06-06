// `mrc rooms [status|brake|resume|steer|end]` — observe and steer ambient pairings by talking
// to the room daemon's control socket (port recorded in ~/.local/share/mrc/room-daemon.json).
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function daemonControlPort() {
  try { return JSON.parse(readFileSync(join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json'), 'utf8')).controlPort } catch { return null }
}
function ctrl(controlPort, action, extra = {}) {
  return new Promise((res, rej) => {
    const c = net.connect(controlPort, '127.0.0.1', () => c.write(JSON.stringify({ action, ...extra }) + '\n'))
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { res(JSON.parse(buf.slice(0, i))) } catch { res(null) } c.end() } })
    c.on('error', () => rej(new Error('room daemon not reachable')))
    setTimeout(() => rej(new Error('daemon did not respond')), 3000)
  })
}

function printHelp() {
  console.log(`mrc rooms — watch & steer negotiation rooms (live cross-session conversations)

A "room" pairs two running mrc sessions so their agents can consult each other. You open one
from INSIDE a session — e.g. say "ask the server about X": the agent calls list_peers, shows you
the connected sessions, you pick one, and it relays. These commands let you observe and control
that relay from any terminal on this machine (they talk to the room daemon).

USAGE
  mrc rooms [command] [room-id]

COMMANDS
  status, ls                    Show connected sessions and active rooms.
                                  Sessions:  <name> (<repo>) [<session-id>]
                                  Rooms:     <a> <-> <b> · <state> · turn N  [<room-id>]
  brake  [room-id]              Pause a room: the daemon stops delivering and HOLDS the next
                                  message. Use the moment it heads the wrong way.
  resume [room-id]              Resume: deliver any held message and continue.
  steer  [--room <id>] [--target a|b] <text>
                                Inject a trusted "[Human directive]: <text>" into the room
                                  (default: both sides). Course-corrects mid-negotiation and
                                  drops a held wrong-path message.
  end    [room-id]              Close a room. Both sides are notified; the transcript and
                                  consensus are preserved on disk (the room can be resumed).
  help, --help                  Show this.

ROOM IDS
  Listed by 'mrc rooms status' (e.g. "RP-Diet--rp"). brake / resume / end take an OPTIONAL id;
  with none they act on the sole open room and refuse when several are open — never "close all".

FILES  (per room, on the host; also mounted at /rooms/<id>/ inside both containers)
  ~/.local/share/mrc/rooms/<id>/thread.log     full relayed transcript — 'tail -f' to watch live
  ~/.local/share/mrc/rooms/<id>/consensus.md   shared agreed record — edit it to steer; both
                                               agents see the change

RESUMING
  Room ids are stable (the --room name, or the two participants' names), so closing then
  re-opening / re-asking the same peer reuses the same room: thread.log and consensus.md keep
  accumulating, and an agent catches up by reading thread.log (never relies on its own memory).

EXAMPLES
  mrc rooms status
  mrc rooms brake RP-Diet--rp
  mrc rooms steer --target b "the refund is async via webhook — re-approach"
  mrc rooms resume RP-Diet--rp
  mrc rooms end RP-Diet--rp`)
}

export async function roomsCommand(args) {
  const sub = args[0] || 'status'
  if (sub === 'help' || sub === '--help' || sub === '-h') { printHelp(); return }
  const port = daemonControlPort()
  if (!port) { console.log('  No room daemon running (start a session with --rooms).'); return }

  try {
    if (sub === 'status' || sub === 'ls') {
      const s = await ctrl(port, 'status')
      console.log('  Sessions:')
      for (const x of s.sessions) console.log(`    ${x.name}${x.name !== x.repo ? `  (${x.repo})` : ''}  [${x.id}]`)
      console.log('  Pairings:')
      if (!s.pairings.length) console.log('    (none)')
      for (const p of s.pairings) {
        console.log(`    ${p.a} <-> ${p.b}  ·  ${p.state}${p.pauseReason ? `(${p.pauseReason})` : ''}  ·  turn ${p.turn}  [${p.roomId}]`)
      }
      return
    }

    switch (sub) {
      // brake | resume | end take an optional room id (from `mrc rooms status`); without one
      // they act on the sole open room and refuse if several are open (no "close all").
      case 'brake': case 'resume': case 'end': {
        const roomId = args[1] && !args[1].startsWith('-') ? args[1] : undefined
        const r = await ctrl(port, sub, { roomId })
        if (!r.ok) { console.error(`  ! ${r.error}`); break }
        if (sub === 'brake') console.log(`  braked.${r.held ? `\n  held: ${r.held}` : ''}`)
        else if (sub === 'resume') console.log('  resumed.')
        else console.log(`  closed${roomId ? ` ${roomId}` : ''} (transcript preserved).`)
        break
      }
      case 'steer': {
        // mrc rooms steer [--room <id>] [--target a|b] <text>
        let parts = args.slice(1), target = 'both', rid
        const ti = parts.indexOf('--target'); if (ti >= 0) { target = parts[ti + 1]; parts = parts.slice(0, ti).concat(parts.slice(ti + 2)) }
        const ri = parts.indexOf('--room'); if (ri >= 0) { rid = parts[ri + 1]; parts = parts.slice(0, ri).concat(parts.slice(ri + 2)) }
        const text = parts.join(' ').trim()
        if (!text) { console.error('Usage: mrc rooms steer [--room <id>] [--target a|b] <text>'); process.exit(1) }
        const r = await ctrl(port, 'steer', { roomId: rid, target, text })
        console.log(r.ok ? `  steered (${target}).` : `  ! ${r.error}`)
        break
      }
      default: console.error(`  unknown: mrc rooms ${sub}  (status | brake | resume | end | steer)`); process.exit(1)
    }
  } catch (e) {
    console.error(`  ! ${e.message}`)
    process.exit(1)
  }
}
