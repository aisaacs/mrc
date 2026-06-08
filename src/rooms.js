// Room-directory manager (host-side). Rooms live at ~/.local/share/mrc/rooms/<roomId>/,
// distinct from each repo's project-local .mrc/. Each room holds consensus.md (a living shared
// summary), thread.log (append-only transcript), and room.json (metadata).
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
  `# Shared summary — ${roomId}\n\n` +
  `Sides: A = ${repoA}  |  B = ${repoB}\n\n` +
  `> A living summary of what the two sessions have established — refreshed by either agent via\n` +
  `> update_notes, and editable by the human to steer (both sessions read it at\n` +
  `> /rooms/${roomId}/consensus.md). Notes, not a contract: the room never "completes" on it —\n` +
  `> the human ends it when done.\n\n---\n\n(no summary yet)\n`

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
  const cur = existsSync(join(dir, 'consensus.md')) ? readFileSync(join(dir, 'consensus.md'), 'utf8') : '# Shared summary\n\n---\n'
  const head = cur.split('\n---\n')[0]
  writeFileSync(join(dir, 'consensus.md'), `${head}\n---\n\n${text}\n`)
}

// --- catch-up panes -------------------------------------------------------
// One per-pause handoff digest for the human, kept as an ordered list per room. Each entry:
//   { seq, ts, pauseReason, status:'pending'|'ready', expected, handoffs:{a?:{name,text},b?:{name,text}}, reviewedAt }
// reviewedAt is set only by an explicit "mark reviewed" — opening a pane never marks it.
const catchupsFile = (roomId) => join(roomDir(roomId), 'catchups.json')

export function readCatchups(roomId) {
  try { return JSON.parse(readFileSync(catchupsFile(roomId), 'utf8')) } catch { return [] }
}
export function appendCatchup(roomId, entry) {
  const list = readCatchups(roomId)
  const seq = (list.length ? list[list.length - 1].seq : 0) + 1
  list.push({ ...entry, seq, reviewedAt: null })
  writeFileSync(catchupsFile(roomId), JSON.stringify(list, null, 2))
  return seq
}
export function updateCatchup(roomId, seq, patch) {
  const list = readCatchups(roomId)
  const e = list.find((x) => x.seq === seq)
  if (!e) return null
  Object.assign(e, patch)
  writeFileSync(catchupsFile(roomId), JSON.stringify(list, null, 2))
  return e
}
