// Roster: parse + normalize a team.json into the model the launcher and daemon use.
//
// team.json (per-repo, or passed to `mrc team`):
//   {
//     "org": "myproject",                 // optional; defaults to repo basename
//     "repo": "/abs/path/to/repo",        // optional; defaults to cwd at load time
//     "teams": [
//       { "name": "client", "territory": "client", "members": [
//           { "role": "architect", "backend": "claude", "lead": true },
//           { "role": "writer",    "backend": "claude", "territory": "client/src" },
//           { "role": "critic",    "backend": "codex" }
//       ]}
//     ]
//   }
//
// Normalized output: { org, repo, members[], teams[], rooms[] }. Every member gets a unique
// `first` name + `handle` (first/backend), a stable `id`, a resolved `territory`/`mount`/`tier`,
// and a `lead` flag. Rooms are derived: one team room per team + one leads room (leads + @user).
import { readFileSync, existsSync } from 'node:fs'
import { basename, isAbsolute, join, normalize } from 'node:path'
import { pickFirstName, makeHandle, backendFamily } from './names.js'
import { roleDef } from './personas.js'

// Backends we can actually launch. claude = live channel member; others = task-workers.
export const KNOWN_BACKENDS = new Set(['claude', 'codex', 'qwen', 'gemini'])
const LIVE_BACKENDS = new Set(['claude'])   // only Claude has the async inbound-injection channel

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

// Keep a territory inside the repo: strip leading slashes, normalize, reject `..` escapes.
function resolveTerritory(raw, fallback) {
  let t = raw == null || raw === '' ? fallback : raw
  t = String(t).trim()
  if (t === '' || t === '.' || t === '/') return '.'
  t = normalize(t.replace(/^\/+/, ''))
  if (t === '..' || t.startsWith('../')) throw new Error(`territory "${raw}" escapes the repo`)
  return t
}

export function teamRoomId(org, team) { return `${slug(org)}--${slug(team)}--team` }
export function leadsRoomId(org) { return `${slug(org)}--leads` }

// Deterministic RNG seeded from a string (mulberry32). Used so a roster WITHOUT pinned names still
// assigns the SAME handles on every run — otherwise each `mrc team up` would mint new names and the
// daemon would accumulate ghost members whose rooms no one rejoins.
function rngFromString(s) {
  let h = 1779033703 ^ String(s).length
  for (let i = 0; i < String(s).length; i++) { h = Math.imul(h ^ String(s).charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19) }
  let a = h >>> 0
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export function parseRoster(input, { repo, rng } = {}) {
  const data = typeof input === 'string' ? JSON.parse(input) : input
  if (!data || typeof data !== 'object') throw new Error('roster: not an object')
  const repoPath = data.repo || repo || process.cwd()
  const org = data.org || basename(repoPath) || 'org'
  const teamsIn = Array.isArray(data.teams) ? data.teams : []
  rng = rng || rngFromString(`mrc-team:${org}`)   // stable per-org names by default

  const taken = new Set()
  // Honor any explicitly-pinned first names first, so auto-assignment works around them.
  for (const t of teamsIn) for (const m of t.members || []) {
    if (m.name) taken.add(String(m.name).toLowerCase())
  }

  const members = []
  const teams = []
  for (const t of teamsIn) {
    const teamName = t.name || `team-${teams.length + 1}`
    const teamTerritory = resolveTerritory(t.territory, '.')
    const memberIds = []
    let leadHandle = null
    const memsIn = Array.isArray(t.members) ? t.members : []
    const normMembers = memsIn.map((m) => {
      const role = m.role || 'writer'
      const def = roleDef(role)
      const backend = backendFamily(m.backend || 'claude')
      const first = m.name ? String(m.name) : pickFirstName(taken, rng)
      taken.add(first.toLowerCase())
      const handle = makeHandle(first, backend)
      const tier = LIVE_BACKENDS.has(backend) ? def.tier : 'worker'
      const mount = m.mount || def.mount
      const territory = resolveTerritory(m.territory, teamTerritory)
      const lead = m.lead === true
      return {
        id: `${slug(org)}:${slug(teamName)}:${handle.replace('/', '-')}`,
        first, backend, handle,
        role, roleLabel: def.label,
        team: teamName, lead, tier, territory, mount,
      }
    })
    // Exactly one lead per team: honor an explicit lead, else the first architect, else the first member.
    const explicit = normMembers.find((m) => m.lead)
    const lead = explicit || normMembers.find((m) => m.role === 'architect') || normMembers[0]
    for (const m of normMembers) m.lead = m === lead
    leadHandle = lead ? lead.handle : null
    for (const m of normMembers) { members.push(m); memberIds.push(m.handle) }
    teams.push({ name: teamName, territory: teamTerritory, leadHandle, members: memberIds })
  }

  // Derived rooms: one team room per team, plus one leads room with every team lead + @user.
  const rooms = teams.map((t) => ({
    roomId: teamRoomId(org, t.name), kind: 'team', team: t.name, members: [...t.members],
  }))
  const leadHandles = teams.map((t) => t.leadHandle).filter(Boolean)
  if (leadHandles.length) {
    rooms.push({ roomId: leadsRoomId(org), kind: 'leads', team: null, members: [...leadHandles, '@user'] })
  }

  return { org, repo: repoPath, members, teams, rooms }
}

export function validateRoster(norm) {
  const errors = []
  const warnings = []
  if (!norm.members.length) errors.push('roster has no members')
  for (const m of norm.members) {
    if (!KNOWN_BACKENDS.has(m.backend)) warnings.push(`member @${m.handle}: unknown backend "${m.backend}"`)
    if (!ROLES_OK(m.role)) warnings.push(`member @${m.handle}: unknown role "${m.role}" (treated generically)`)
    if (m.mount === 'rw' && m.backend !== 'claude' && m.tier !== 'worker') {
      warnings.push(`member @${m.handle}: rw worker — edits apply per directed invocation`)
    }
  }
  // Overlapping write territories within a team cause file contention — the whole point is to avoid it.
  const writers = norm.members.filter((m) => m.mount === 'rw')
  for (let i = 0; i < writers.length; i++) for (let j = i + 1; j < writers.length; j++) {
    if (territoriesOverlap(writers[i].territory, writers[j].territory)) {
      warnings.push(`writers @${writers[i].handle} and @${writers[j].handle} share write territory ` +
        `("${writers[i].territory}" vs "${writers[j].territory}") — risk of edit contention`)
    }
  }
  return { errors, warnings, ok: errors.length === 0 }
}

function ROLES_OK(role) {
  // Mirrors personas.ROLES keys without importing the whole map; unknown roles are allowed (warned).
  return ['architect', 'writer', 'critic', 'adversary', 'ultracritical', 'user-defender', 'researcher'].includes(role)
}

function territoriesOverlap(a, b) {
  if (a === '.' || b === '.') return true
  const pa = a.split('/'), pb = b.split('/')
  const n = Math.min(pa.length, pb.length)
  for (let i = 0; i < n; i++) if (pa[i] !== pb[i]) return false
  return true   // one is a prefix of the other → nested → overlap
}

export function loadRosterFile(path, opts = {}) {
  if (!existsSync(path)) throw new Error(`roster file not found: ${path}`)
  return parseRoster(readFileSync(path, 'utf8'), opts)
}

// Conventional roster locations for a repo, most-specific first.
export function rosterCandidates(repo) {
  return [join(repo, 'team.json'), join(repo, '.mrc', 'team.json'), join(repo, 'mrc-team.json')]
}
export function findRoster(repo) {
  return rosterCandidates(repo).find((p) => existsSync(p)) || null
}
