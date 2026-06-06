// `mrc room <cmd> <roomId>` — observe and steer a running negotiation room by talking to the
// broker's localhost control socket (port recorded in the room's room.json).
import net from 'node:net'
import { loadRoom, listRooms } from '../rooms.js'

function ctrl(controlPort, action, extra = {}) {
  return new Promise((res, rej) => {
    const c = net.connect(controlPort, '127.0.0.1', () => c.write(JSON.stringify({ action, ...extra }) + '\n'))
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { res(JSON.parse(buf.slice(0, i))) } catch { res(null) } c.end() } })
    c.on('error', () => rej(new Error('broker not reachable (is the room still running?)')))
    setTimeout(() => rej(new Error('broker did not respond')), 3000)
  })
}

export async function roomCommand(args) {
  const sub = args[0] || 'ls'

  if (sub === 'ls' || sub === 'list') {
    const rooms = listRooms()
    if (!rooms.length) { console.log('  No rooms.'); return }
    for (const r of rooms) {
      console.log(`  ${r.roomId}  [${r.meta.state}]  ${r.meta.repoA} <-> ${r.meta.repoB || '(pending)'}`)
    }
    return
  }

  const roomId = args[1]
  if (!roomId) { console.error(`Usage: mrc room ${sub} <roomId>`); process.exit(1) }
  let room
  try { room = loadRoom(roomId) } catch { console.error(`Room not found: ${roomId}  (try: mrc room ls)`); process.exit(1) }
  const controlPort = room.meta.controlPort
  if (!controlPort) { console.error('Room has no broker control port recorded.'); process.exit(1) }

  try {
    switch (sub) {
      case 'status': {
        const s = await ctrl(controlPort, 'status')
        console.log(JSON.stringify(s, null, 2))
        break
      }
      case 'brake': {
        const s = await ctrl(controlPort, 'brake')
        console.log(`  braked.${s && s.held ? `\n  held: ${s.held}` : ' (nothing in flight)'}`)
        break
      }
      case 'resume':
        await ctrl(controlPort, 'resume'); console.log('  resumed.'); break
      case 'steer': {
        // mrc room steer <roomId> [--target A|B|both] <text...>
        let parts = args.slice(2)
        let target = 'both'
        const ti = parts.indexOf('--target')
        if (ti >= 0) { target = parts[ti + 1]; parts = parts.slice(0, ti).concat(parts.slice(ti + 2)) }
        const text = parts.join(' ').trim()
        if (!text) { console.error('Usage: mrc room steer <roomId> [--target A|B|both] <text>'); process.exit(1) }
        await ctrl(controlPort, 'steer', { target, text })
        console.log(`  steered (${target}).`)
        break
      }
      case 'end':
        await ctrl(controlPort, 'end'); console.log('  room ended.'); break
      default:
        console.error(`Unknown room command: ${sub}  (status|brake|resume|steer|end|ls)`)
        process.exit(1)
    }
  } catch (e) {
    console.error(`  ! ${e.message}`)
    process.exit(1)
  }
}
