// `mrc rooms [status|brake|resume|steer]` — observe and steer ambient pairings by talking
// to the room daemon's control socket (port recorded in ~/.local/share/mrc/room-daemon.json).
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function readMeta() {
  try { return JSON.parse(readFileSync(join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json'), 'utf8')) } catch { return null }
}
function daemonControlPort() { return readMeta()?.controlPort ?? null }
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
                                  Rooms:     <member> <-> <member> [<-> …] · <state> · turn N  [<room-id>]
  brake  [room-id]              Pause a room: the daemon stops delivering and HOLDS the next
                                  message. Use the moment it heads the wrong way.
  resume [room-id]              Resume: deliver any held message and continue.
  steer  [--room <id>] [--target <name>|both] <text>
                                Inject a trusted "[Human directive]: <text>" into the room
                                  (default: both sides; --target <name> hits one member). Course-
                                  corrects mid-negotiation and drops a held wrong-path message.
  auto-accept [id] [on|off]    Whether adversaries join THIS room without a consent prompt. DEFAULT ON
                                  (one trust domain — the summoner owns getting them into the right room).
                                  Set "off" to add a consent checkpoint for the room.
  accept / decline [room-id]   Approve / refuse a pending adversary invite (only relevant when a room has
                                  auto-accept OFF). You can also just say "let Pierre in" in that session,
                                  or use the dashboard. Read /rooms/<id>/adversary-brief.md first.
  restart                       Refresh the room daemon in place (same ports) so every connected
                                  session reconnects to current code. Run after updating mrc.
                                  Cold-starts one if none is running (no need to launch a session first).
  stop                          Stop the room daemon (no respawn). It also auto-stops ~10 min
                                  after the last session disconnects; the next session reboots it.
  dashboard, ui                 Open a local web dashboard (127.0.0.1) to read every room's full
                                  thread.log + consensus.md (live & historical, untruncated) and
                                  pause / resume / steer them with buttons.
  help, --help                  Show this.

ROOM IDS
  Listed by 'mrc rooms status' (e.g. "RP-Diet--rp"). brake / resume take an OPTIONAL id; with
  none they act on the sole open room and refuse when several are open.

FILES  (per room, on the host; also mounted at /rooms/<id>/ inside both containers)
  ~/.local/share/mrc/rooms/<id>/thread.log     full relayed transcript — 'tail -f' to watch live
  ~/.local/share/mrc/rooms/<id>/consensus.md   living shared summary — edit it to steer; both
                                               agents see the change

RESUMING
  Room ids are stable (the --room name, or the two participants' names), so closing then
  re-opening / re-asking the same peer reuses the same room: thread.log and consensus.md keep
  accumulating, and an agent catches up by reading thread.log (never relies on its own memory).

EXAMPLES
  mrc rooms dashboard
  mrc rooms status
  mrc rooms brake RP-Diet--rp
  mrc rooms steer --target b "the refund is async via webhook — re-approach"
  mrc rooms resume RP-Diet--rp`)
}

export async function roomsCommand(args) {
  const sub = args[0] || 'status'
  if (sub === 'help' || sub === '--help' || sub === '-h') { printHelp(); return }
  if (sub === 'restart') {
    const { restartRoomDaemon } = await import('./pair.js')
    const r = await restartRoomDaemon()
    console.log(r.ok
      ? (r.coldStarted
        ? `  ◎ no room daemon was running — cold-started one on :${r.port}.`
        : r.degraded
          ? `  ↻ room daemon restarted, but its relay port :${r.port} is blocked by another listener — peers can't connect yet. It keeps retrying that exact port (it never moves), so once the squatter clears everything reconnects on its own; check \`mrc rooms status\`.`
          : `  ↻ room daemon restarted on :${r.port} — connected sessions will reconnect.`)
      : `  ! ${r.error}`)
    return
  }
  if (sub === 'stop') {
    const { stopRoomDaemon } = await import('./pair.js')
    const r = await stopRoomDaemon()
    console.log(r.ok ? '  ⏹ room daemon stopped.' : `  ! ${r.error}`)
    return
  }
  if (sub === 'dashboard' || sub === 'ui' || sub === 'web') {
    // Boot-or-reuse the daemon (it hosts the dashboard), then just open the browser and exit — the
    // daemon keeps serving, and an open dashboard keeps it alive, so there's no tab to babysit.
    const { ensureRoomDaemon } = await import('./pair.js')
    const { openBrowser } = await import('../rooms-dashboard.js')
    try { await ensureRoomDaemon({ relayPort: Number(process.env.MRC_PORT_BASE) || 7722, notifyPort: 0 }) }
    catch (e) { console.error(`  ! could not start the room daemon: ${e.message}`); process.exit(1) }
    // The daemon records its dashboard port a beat after its control port answers; poll briefly.
    let dashboardPort = readMeta()?.dashboardPort
    for (let i = 0; !dashboardPort && i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); dashboardPort = readMeta()?.dashboardPort }
    if (!dashboardPort) { console.error('  ! the daemon is not serving a dashboard (MRC_DASHBOARD_PORT=0?).'); return }
    const url = `http://127.0.0.1:${dashboardPort}/`
    console.log(`  ◎ Rooms dashboard: ${url}`)
    console.log('    Served by the room daemon — it stays up while you have sessions OR this dashboard open,')
    console.log('    so you can close this terminal. (It boots the daemon if it was shut down.)')
    openBrowser(url)
    return
  }
  const port = daemonControlPort()
  if (!port) { console.log('  No room daemon running (start a session with --rooms).'); return }

  try {
    if (sub === 'status' || sub === 'ls') {
      const s = await ctrl(port, 'status')
      console.log(`  Daemon:   v${s.version || '(unknown — stale code; run: mrc rooms restart)'}`)
      if (s.relayBound === false) console.log('  ⚠ Relay port BLOCKED — the daemon is up but its relay port is squatted by another listener, so sessions can\'t connect. It retries that exact port (never moves); clear the squatter or relaunch.')
      console.log('  Sessions:')
      for (const x of s.sessions) console.log(`    ${x.name}${x.name !== x.repo ? `  (${x.repo})` : ''}  [${x.id}]`)
      console.log('  Pairings:')
      if (!s.pairings.length) console.log('    (none)')
      for (const p of s.pairings) {
        const who = (p.members && p.members.length ? p.members : [p.a, p.b].filter(Boolean)).join(' <-> ')
        // #50: flag a PARTIALLY-connected room (some members on, some off) — the stranded-peer signal
        // (e.g. the daemon port moved out from under one side). A fully-empty room is just dormant, no nag.
        const memberCount = (p.members && p.members.length) || [p.a, p.b].filter(Boolean).length
        const stranded = p.awaiting && p.awaiting.length && p.awaiting.length < memberCount
        const flags = `${p.pendingInvite ? `  ·  ⏳ adversary invite pending from ${p.pendingInvite} (accept in that session, or \`mrc rooms accept/decline ${p.roomId}\`)` : ''}${p.requireConsent ? '  ·  consent-required' : ''}${stranded ? `  ·  ⏳ awaiting reconnect: ${p.awaiting.join(', ')} (if it dropped off unexpectedly, relaunch that session)` : ''}`
        console.log(`    ${who}  ·  ${p.state}${p.pauseReason ? `(${p.pauseReason})` : ''}  ·  turn ${p.turn}  [${p.roomId}]${flags}`)
      }
      return
    }

    switch (sub) {
      // brake | resume take an optional room id (from `mrc rooms status`); without one they act
      // on the sole open room and refuse if several are open.
      case 'brake': case 'resume': {
        const roomId = args[1] && !args[1].startsWith('-') ? args[1] : undefined
        const r = await ctrl(port, sub, { roomId })
        if (!r.ok) { console.error(`  ! ${r.error}`); break }
        console.log(sub === 'brake' ? `  braked.${r.held ? `\n  held: ${r.held}` : ''}` : '  resumed.')
        break
      }
      case 'accept': case 'decline': {
        const roomId = args[1] && !args[1].startsWith('-') ? args[1] : undefined
        const r = await ctrl(port, sub, { roomId })
        if (!r.ok) { console.error(`  ! ${r.error}`); break }
        console.log(sub === 'accept' ? '  accepted — a fresh adversary is joining the room on the open brief.' : '  declined.')
        break
      }
      case 'auto-accept': {
        // mrc rooms auto-accept <room> [on|off]  — DEFAULT on; "off" adds a consent checkpoint to the room
        const roomId = args.slice(1).find((a) => !a.startsWith('-') && a !== 'on' && a !== 'off')
        const on = !(args.includes('off') || args.includes('--off'))
        const r = await ctrl(port, 'autoaccept', { roomId, on })
        console.log(r.ok ? `  auto-accept ${r.autoAccept ? 'ON — adversaries join this room immediately' : 'OFF — adversaries need consent (say "let Pierre in" in the room, the dashboard, or mrc rooms accept)'}.` : `  ! ${r.error}`)
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
      default: console.error(`  unknown: mrc rooms ${sub}  (status | brake | resume | steer | accept | decline | auto-accept)`); process.exit(1)
    }
  } catch (e) {
    console.error(`  ! ${e.message}`)
    process.exit(1)
  }
}
