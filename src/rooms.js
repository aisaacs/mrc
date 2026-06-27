// Room-directory manager (host-side). Rooms live at ~/.local/share/mrc/rooms/<roomId>/,
// distinct from each repo's project-local .mrc/. Each room holds consensus.md (a living shared
// summary), thread.log (append-only transcript), and room.json (metadata).
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync, unlinkSync } from 'node:fs'
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
  writeFileSync(join(dir, 'transcript.jsonl'), '')   // #18: structured per-message store (trusted qids)
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
  if (!existsSync(f('transcript.jsonl'))) writeFileSync(f('transcript.jsonl'), '')   // #18: structured store
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

// Structured transcript (#18): ONE JSON record per logical message, parallel to thread.log. Carries
// the daemon's TRUSTED per-message qid/reqid so the dashboard can anchor `[#N]` / `(re #N)` jumps from
// a field it authored — never by text-scanning the human-readable log (which a member could spoof, incl.
// via a `\n` in their message body). `t` is the exact line text; `q`/`r` are null unless the daemon set
// them. One record per append ⇒ a member's newline stays inside one record's `t`, forging nothing.
export function appendTranscript(roomId, record) {
  // JSON.stringify escapes any newline in `t` to \n, so each record is exactly one physical line.
  appendFileSync(join(roomDir(roomId), 'transcript.jsonl'), JSON.stringify(record) + '\n')
}
export function readTranscript(roomId) {
  const dir = roomDir(roomId)
  const tf = join(dir, 'transcript.jsonl')
  try {
    const recs = readFileSync(tf, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    if (recs.length) return recs
  } catch {}
  // Backfill a PRE-#18 room (thread.log content but no structured transcript yet): seed transcript.jsonl
  // from the existing lines as INERT records (q/r null → no anchors/jumps for old content, which is the
  // safe default — we never assign trusted qids by re-parsing old text). Seeding persists it so the
  // history doesn't vanish once a NEW (anchored) message appends a record. One-time, idempotent.
  try {
    const old = readFileSync(join(dir, 'thread.log'), 'utf8')
    if (!old.trim()) return []
    const recs = old.split('\n').filter((l) => l.length).map((t) => ({ t, q: null, r: null }))
    try { appendFileSync(tf, recs.map((r) => JSON.stringify(r)).join('\n') + '\n') } catch {}
    return recs
  } catch { return [] }
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

// --- pairing survival across a graceful daemon restart -------------------
// The daemon's pairings are in-memory, so `mrc rooms restart` would otherwise drop an in-flight
// room (and a later `reply` silently goes nowhere). On shutdown it dumps them here; the next daemon
// restores them (turn count / autoCatchup preserved) — sockets re-attach as sessions reconnect.
const daemonDir = () => join(homedir(), '.local', 'share', 'mrc')
const pairingsFile = () => join(daemonDir(), 'room-pairings.json')
export function savePairings(list) {
  try { mkdirSync(daemonDir(), { recursive: true }); writeFileSync(pairingsFile(), JSON.stringify({ at: Date.now(), pairings: list })) } catch {}
}
export function loadPairings({ maxAgeMs = 120_000 } = {}) {
  try {
    const j = JSON.parse(readFileSync(pairingsFile(), 'utf8'))
    try { unlinkSync(pairingsFile()) } catch {}          // consume once — don't restore the same dump twice
    return (Date.now() - (j.at || 0) <= maxAgeMs) ? (j.pairings || []) : []   // ignore a stale dump (sessions long gone)
  } catch { return [] }
}

// --- team org definitions (declared rooms + members) ----------------------
// Unlike ambient pairings, a team org is declared up front by `mrc team` and should survive a daemon
// refresh so already-running members keep their rooms. Persisted (not consumed) and re-pushed by the
// launcher on each run, so a stale def is harmless — the next `mrc team` overwrites it.
const orgsFile = () => join(daemonDir(), 'room-orgs.json')
export function saveOrgs(list) {
  try { mkdirSync(daemonDir(), { recursive: true }); writeFileSync(orgsFile(), JSON.stringify({ at: Date.now(), orgs: list }, null, 2)) } catch {}
}
export function loadOrgs() {
  try { return JSON.parse(readFileSync(orgsFile(), 'utf8')).orgs || [] } catch { return [] }
}

// --- @user inbox durable store (#16) --------------------------------------
// The engine's userInbox is in-memory; without this a `mrc rooms restart` (or a version-refresh)
// loses every pending question/notification — a data-loss the human flagged. Persist the whole inbox
// (incl. answered/dismissed, so history + show-dismissed survive) and restore it on boot.
const inboxFile = () => join(daemonDir(), 'room-inbox.json')
export function loadInbox() { try { return JSON.parse(readFileSync(inboxFile(), 'utf8')).items || [] } catch { return [] } }
export function saveInbox(items) {
  try { mkdirSync(daemonDir(), { recursive: true }); writeFileSync(inboxFile(), JSON.stringify({ at: Date.now(), items }, null, 2)) } catch {}
}

// --- Telegram per-org durable state (#12) ---------------------------------
// Persists only the durable bits — getUpdates `offset`, the `maxUpdateId` dedup high-water-mark, and
// the `pinned` authorized user — so a daemon restart doesn't replay updates or lose the link. The bot
// `token` is NOT persisted (re-read from the repo .env each boot, host-side); `pending` is ephemeral
// (a restart just makes the user re-/start). Keyed by org.
const tgFile = () => join(daemonDir(), 'room-telegram.json')
export function loadTgStates() { try { return JSON.parse(readFileSync(tgFile(), 'utf8')).orgs || {} } catch { return {} } }
export function saveTgStates(map) {
  try { mkdirSync(daemonDir(), { recursive: true }); writeFileSync(tgFile(), JSON.stringify({ at: Date.now(), orgs: map }, null, 2)) } catch {}
}

// --- GUI launch registry (org -> tmux session + embedded ttyd) ------------
// Written by `mrc team up` (which runs the risky image build in ITS OWN process, so a build failure
// can't take down the daemon), read by the daemon to report launch state to the dashboard.
const launchesFile = () => join(daemonDir(), 'team-launches.json')
export function loadLaunches() { try { return JSON.parse(readFileSync(launchesFile(), 'utf8')) } catch { return {} } }
export function saveLaunch(org, info) {
  const all = loadLaunches(); all[org] = { ...info, at: Date.now() }
  try { mkdirSync(daemonDir(), { recursive: true }); writeFileSync(launchesFile(), JSON.stringify(all, null, 2)) } catch {}
}
export function removeLaunch(org) {
  const all = loadLaunches(); delete all[org]
  try { writeFileSync(launchesFile(), JSON.stringify(all, null, 2)) } catch {}
}
