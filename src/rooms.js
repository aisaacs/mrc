// Room-directory manager (host-side). Rooms live at ~/.local/share/mrc/rooms/<roomId>/,
// distinct from each repo's project-local .mrc/. Each room holds consensus.md (the agreed
// record), thread.log (append-only transcript), and room.json (metadata).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

export function roomsRoot() { return join(homedir(), '.local', 'share', 'mrc', 'rooms') }
export function roomDir(roomId) { return join(roomsRoot(), roomId) }

export function makeRoomId(repoA, repoB, stamp = Date.now()) {
  const clean = (p) => basename(p).replace(/[^A-Za-z0-9_-]/g, '') || 'repo'
  return `${clean(repoA)}--${clean(repoB)}-${(stamp >>> 0).toString(16)}`
}

const consensusTemplate = (roomId, repoA, repoB) =>
  `# Consensus — ${roomId}\n\n` +
  `Sides: A = ${repoA}  |  B = ${repoB}\n\n` +
  `> The agreed record both sides adopt. Edit this file freely to steer the negotiation —\n` +
  `> both sessions can read it at /room/consensus.md. The room completes when both sides\n` +
  `> sign matching text.\n\n---\n\n(no consensus yet)\n`

export function createRoom(repoA, repoB, stamp = Date.now()) {
  const roomId = makeRoomId(repoA, repoB, stamp)
  const dir = roomDir(roomId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'consensus.md'), consensusTemplate(roomId, repoA, repoB))
  writeFileSync(join(dir, 'thread.log'), '')
  const meta = { roomId, repoA, repoB, createdAt: stamp, state: 'open' }
  writeFileSync(join(dir, 'room.json'), JSON.stringify(meta, null, 2))
  return { roomId, dir, meta }
}

// Idempotent room setup keyed by an explicit roomId (the user's --room name). Safe to call
// from both paired sessions: creates the dir + files only if missing, never overwrites.
export function ensureRoom(roomId, repoA = '', repoB = '', stamp = Date.now()) {
  const dir = roomDir(roomId)
  mkdirSync(dir, { recursive: true })
  const f = (n) => join(dir, n)
  if (!existsSync(f('consensus.md'))) writeFileSync(f('consensus.md'), consensusTemplate(roomId, repoA, repoB))
  if (!existsSync(f('thread.log'))) writeFileSync(f('thread.log'), '')
  let meta
  if (existsSync(f('room.json'))) meta = JSON.parse(readFileSync(f('room.json'), 'utf8'))
  else { meta = { roomId, repoA, repoB, createdAt: stamp, state: 'open' }; writeFileSync(f('room.json'), JSON.stringify(meta, null, 2)) }
  return { roomId, dir, meta }
}

export function loadRoom(roomId) {
  const dir = roomDir(roomId)
  const meta = JSON.parse(readFileSync(join(dir, 'room.json'), 'utf8'))
  return { roomId, dir, meta }
}

export function saveRoom(roomId, meta) {
  writeFileSync(join(roomDir(roomId), 'room.json'), JSON.stringify(meta, null, 2))
}

export function listRooms() {
  const root = roomsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .filter((d) => existsSync(join(root, d, 'room.json')))
    .map((d) => loadRoom(d))
}

export function appendThread(roomId, line) {
  appendFileSync(join(roomDir(roomId), 'thread.log'), line.endsWith('\n') ? line : line + '\n')
}

// Replace the body below the "---" divider, preserving the header/instructions.
export function writeConsensus(roomId, text) {
  const dir = roomDir(roomId)
  const cur = existsSync(join(dir, 'consensus.md')) ? readFileSync(join(dir, 'consensus.md'), 'utf8') : '# Consensus\n\n---\n'
  const head = cur.split('\n---\n')[0]
  writeFileSync(join(dir, 'consensus.md'), `${head}\n---\n\n${text}\n`)
}
