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
import { roleDef, ROLE_ALIASES } from './personas.js'
import { isMediaRole, mediaBackendForRole } from './media.js'

// Backends we can actually launch. claude = live channel member; codex = task-worker agent.
// gemini/elevenlabs are MEDIA backends, never picked directly — they're DERIVED from a media role.
export const KNOWN_BACKENDS = new Set(['claude', 'codex', 'gemini', 'elevenlabs'])
export const AGENT_BACKENDS = new Set(['claude', 'codex'])   // the only backends a non-media (agent) role may use
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

// A pinned member `name` (team.json) flows into the handle, the dtach socket PATH, a docker LABEL, and is
// interpolated into the launch `sh -c`. `shq` escapes the sh -c site (and STAYS — this is a second layer,
// not a replacement: a future call-site that forgets shq must still be safe), but reject crafted names at
// the parse boundary too. REJECT, not strip: stripping could collapse two distinct crafted names to ONE
// handle → a registry/socket collision class (the R-dtach-1 family). Allow Unicode letters/digits +
// internal hyphens, so accented names ("côme") and hyphenated ones ("jean-luc") pass; reject spaces,
// quotes, slashes, dots, and every shell metacharacter (' " ` $ ; | & < > ( ) \ newline …).
const SAFE_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u
export function assertSafeName(name, role, kind = 'member name') {
  const s = String(name)
  if (!SAFE_NAME.test(s)) {
    throw new Error(`${kind} ${JSON.stringify(s)}${role ? ` (role "${role}")` : ''} is invalid — names may contain only letters, digits, and internal hyphens (no spaces, quotes, slashes, dots, or shell metacharacters). Fix it.`)
  }
}

// Custom personas — team.json top-level `personas`: { <key>: { label, mandate, mount?, leadByDefault? } }.
// Each KEY becomes a usable @role (and an @mention surface), so validate it like a member name (#36 —
// reject shell/handle-hostile keys at the parse boundary). Custom personas are AGENT charters only: a key
// may NOT redefine a built-in MEDIA role (designer/sound-designer/composer) — those stay built-in because
// they carry generation logic (media.js), not just a charter. NOTE: tier is intentionally NOT read here —
// it is derived from the backend at the member layer (claude→live, codex→worker, #32).
function parsePersonas(raw) {
  const map = {}
  if (raw == null) return map
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('team.json "personas" must be an object map of { key: { label, mandate, mount?, leadByDefault? } }')
  }
  for (const [key, val] of Object.entries(raw)) {
    assertSafeName(key, null, 'persona key')   // keys become @mentions — reject crafted ones
    // A key that IS a built-in alias ("writer"→"engineer", "qa"→"tester") would silently never resolve —
    // roleDef aliases the role BEFORE the custom lookup, so the custom def is dead. Reject (same class as
    // the media reject) rather than ship a foot-gun where `personas.writer` is quietly ignored.
    if (ROLE_ALIASES[key]) throw new Error(`persona "${key}" collides with a built-in role alias ("${key}" → "${ROLE_ALIASES[key]}") — it would never resolve. Rename it, or define the canonical role "${ROLE_ALIASES[key]}".`)
    if (isMediaRole(key)) throw new Error(`persona "${key}" may not be redefined — media roles (designer/sound-designer/composer) are built-in`)
    if (!val || typeof val !== 'object' || Array.isArray(val)) throw new Error(`persona "${key}" must be an object with at least a "mandate"`)
    // The mandate IS the role's definition — a charter-less custom persona makes buildPersona emit a
    // role header with no instructions (silent uselessness). Enforce it HERE, the single boundary, so a
    // hand-edited team.json fails loud at launch too (not just via the editor). Honors the message above.
    if (!String(val.mandate ?? '').trim()) throw new Error(`persona "${key}" needs a non-empty "mandate" (its charter)`)
    map[key] = {
      label: val.label != null ? String(val.label) : key,
      mandate: val.mandate != null ? String(val.mandate) : '',
      ...(val.mount != null ? { mount: val.mount === 'rw' ? 'rw' : 'ro' } : {}),
      leadByDefault: val.leadByDefault === true,
    }
  }
  return map
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
  const org = data.project || data.org || basename(repoPath) || 'org'   // "project" is the friendly name for "org"
  const teamsIn = Array.isArray(data.teams) ? data.teams : []
  const customPersonas = parsePersonas(data.personas)
  rng = rng || rngFromString(`mrc-team:${org}`)   // stable per-org names by default

  const taken = new Set()
  // Honor any explicitly-pinned first names first, so auto-assignment works around them.
  for (const t of teamsIn) for (const m of t.members || []) {
    if (m.name) { assertSafeName(m.name, m.role); taken.add(String(m.name).toLowerCase()) }   // #36: reject crafted names at the parse boundary (empty/absent → auto-assigned)
  }

  const members = []
  const teams = []
  // #44-1: handles are org-wide unique (the dtach socket, docker `mrc.member` label, launch registry, and
  // engine room-member Set all key on org+handle, team-independent). Two members resolving to the same
  // name+backend would silently collide (one clobbers the other's socket/launch/label, @mentions ambiguate).
  // Auto-assigned names already dodge this via `taken`, but two PINNED same-name+backend members don't —
  // so enforce uniqueness HERE, the single parse boundary (catches the builder, launch, AND a hand-edited
  // team.json). REJECT loud (not silent auto-uniquify, which would surprise). Honors roster.js's own
  // "every member gets a unique handle" contract (lines 16-17).
  const seenHandles = new Set()
  for (const t of teamsIn) {
    const teamName = t.name || `team-${teams.length + 1}`
    const teamTerritory = resolveTerritory(t.territory, '.')
    const memberIds = []
    let leadHandle = null
    const memsIn = Array.isArray(t.members) ? t.members : []
    const normMembers = memsIn.map((m) => {
      const role = ROLE_ALIASES[m.role] || m.role || 'engineer'   // "writer" -> "engineer" (back-compat)
      const def = roleDef(role, customPersonas)   // custom persona → built-in ROLE → generic fallback
      // One axis: agent OR media-maker. A media role DERIVES its backend (gemini/elevenlabs) and ignores
      // any declared one; an agent role keeps its declared backend but should be claude/codex. Either case
      // carries a `backendNote` when something's off so it's never silent (validateRoster surfaces it).
      // We WARN rather than coerce a hand-written bad agent backend — coercing would be its own silent
      // rewrite (wrong ethos); the builder already constrains *creation* to claude/codex.
      const declared = backendFamily(m.backend || 'claude')
      let backend = declared
      let backendNote = null
      if (isMediaRole(role)) {
        backend = mediaBackendForRole(role)
        if (m.backend != null && declared !== backend) backendNote = `declared backend "${declared}" ignored — media role "${role}" uses "${backend}"`
      } else if (!AGENT_BACKENDS.has(declared)) {
        backendNote = `backend "${declared}" is not a supported agent backend for role "${role}" (agents should be claude or codex)`
      }
      const first = m.name ? String(m.name) : pickFirstName(taken, rng)
      taken.add(first.toLowerCase())
      const handle = makeHandle(first, backend)
      // #44-1: org-wide handle uniqueness. Dedup on the FINAL handle (first/backendFamily) so roland/claude
      // and roland/codex stay distinct — only an identical handle throws. REJECT loud, here at the single
      // boundary, rather than mint a silent collision.
      if (seenHandles.has(handle)) throw new Error(`duplicate member handle "@${handle}" — two members resolve to the same name + backend ("${first}" / ${backend}). Member names must be unique per backend across the whole team; rename one.`)
      seenHandles.add(handle)
      const tier = LIVE_BACKENDS.has(backend) ? def.tier : 'worker'
      const mount = m.mount || def.mount
      const territory = resolveTerritory(m.territory, teamTerritory)
      const lead = m.lead === true
      // Resolved persona for this member: label/mandate/leadByDefault from the (custom or built-in)
      // def, with the EFFECTIVE mount + backend-derived tier folded in. buildPersona consumes this.
      const personaDef = { label: def.label, mandate: def.mandate, mount, tier, leadByDefault: def.leadByDefault === true, custom: !!def.custom }
      return {
        id: `${slug(org)}:${slug(teamName)}:${handle.replace('/', '-')}`,
        first, backend, handle,
        role, roleLabel: def.label,
        team: teamName, lead, tier, territory, mount, personaDef,
        ...(backendNote ? { backendNote } : {}),
      }
    })
    // Exactly one lead per team: honor an explicit lead, else the first architect, else a custom persona
    // that opts in via leadByDefault (e.g. a "project-manager" role), else the first member. The
    // leadByDefault clause sits AFTER the architect check so existing teams are unchanged — architect
    // wins ties; it only claims the lead a team without an architect would otherwise hand to member[0].
    const explicit = normMembers.find((m) => m.lead)
    const lead = explicit || normMembers.find((m) => m.role === 'architect') || normMembers.find((m) => m.personaDef?.leadByDefault) || normMembers[0]
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

  return { org, repo: repoPath, members, teams, rooms, customPersonas }
}

export function validateRoster(norm) {
  const errors = []
  const warnings = []
  if (!norm.members.length) errors.push('roster has no members')
  // #44-1: handle uniqueness as a hard ERROR (defense-in-depth — parseRoster already throws on a dup at
  // the parse boundary; this re-asserts the invariant so any path that hands validateRoster a norm with
  // colliding handles still fails loud, and a preview surfaces it).
  const seenHandles = new Set()
  for (const m of norm.members) {
    if (seenHandles.has(m.handle)) errors.push(`duplicate member handle @${m.handle} — two members resolve to the same name + backend (collision); rename one`)
    else seenHandles.add(m.handle)
  }
  for (const m of norm.members) {
    // Surface any backend override parseMember had to make (agent-coerce or media-derive) — never silent.
    if (m.backendNote) warnings.push(`member @${m.handle}: ${m.backendNote}`)
    if (!ROLES_OK(m.role, norm.customPersonas)) warnings.push(`member @${m.handle}: unknown role "${m.role}" (treated generically)`)
    if (m.mount === 'rw' && m.backend !== 'claude' && m.tier !== 'worker') {
      warnings.push(`member @${m.handle}: rw worker — edits apply per directed invocation`)
    }
  }
  // Overlapping write territories between CODE engineers cause file contention — the point is to avoid
  // it. Media makers (distinct binary assets) and the tester (its own tests/ tree) are exempt: writing
  // under an engineer's tree doesn't collide for them.
  const EXEMPT = new Set(['designer', 'sound-designer', 'composer', 'tester'])
  const writers = norm.members.filter((m) => m.mount === 'rw' && !EXEMPT.has(m.role))
  for (let i = 0; i < writers.length; i++) for (let j = i + 1; j < writers.length; j++) {
    if (territoriesOverlap(writers[i].territory, writers[j].territory)) {
      warnings.push(`writers @${writers[i].handle} and @${writers[j].handle} share write territory ` +
        `("${writers[i].territory}" vs "${writers[j].territory}") — risk of edit contention`)
    }
  }
  return { errors, warnings, ok: errors.length === 0 }
}

// Which members currently resolve to a given persona key (honoring the writer/qa aliases). Returns a
// readable ref per member (pinned name, else "role@team") — enough to tell the human who to reassign
// before a persona can be removed. Raw-structure scan (no parse/RNG needed), so it works even on a file
// that wouldn't fully normalize.
function membersUsingRole(data, key) {
  const k = ROLE_ALIASES[key] || key
  const refs = []
  for (const t of (Array.isArray(data?.teams) ? data.teams : [])) {
    for (const m of (Array.isArray(t.members) ? t.members : [])) {
      const r = ROLE_ALIASES[m.role] || m.role || 'engineer'
      if (r === k) refs.push(m.name ? String(m.name) : `${m.role || 'engineer'}@${t.name || '?'}`)
    }
  }
  return refs
}

// Apply a single custom-persona edit to a parsed team.json and return the NEW team.json object — but only
// if the result still parses. parseRoster runs parsePersonas (key/alias/media guards) + builds the members,
// so this is the SINGLE SOURCE OF VALIDATION: the editor can never produce a team.json the launcher would
// later reject. A remove is refused while any member still resolves to the persona (returns `usedBy`).
//   editPersona(data, { op: 'save', key, persona })  → { ok, roster } | { ok:false, error }
//   editPersona(data, { op: 'remove', key })         → { ok, roster } | { ok:false, error, usedBy }
export function editPersona(data, { op, key, persona } = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'no team.json to edit' }
  const next = JSON.parse(JSON.stringify(data))
  next.personas = next.personas && typeof next.personas === 'object' && !Array.isArray(next.personas) ? next.personas : {}
  const k = String(key || '').trim()
  if (!k) return { ok: false, error: 'persona key required' }
  if (op === 'remove') {
    const usedBy = membersUsingRole(next, k)
    if (usedBy.length) return { ok: false, error: `persona "${k}" is still used by ${usedBy.map((r) => '@' + r).join(', ')} — reassign or remove ${usedBy.length > 1 ? 'them' : 'it'} first`, usedBy }
    delete next.personas[k]
  } else if (op === 'save') {
    if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return { ok: false, error: 'persona body required (object with at least a mandate)' }
    // Whitelist to parsePersonas' known shape so junk/unknown fields (e.g. a stray `tier`) never persist
    // into team.json (single trusted writer, but constrain it here). tier is intentionally absent (it's
    // backend-derived, not a persona property). The empty-mandate reject lives in parsePersonas, which
    // the parseRoster gate below runs — so a blank charter is refused there, the single source.
    const clean = { label: String(persona.label || '').trim() || k, mandate: String(persona.mandate || '').trim() }
    if (persona.mount != null) clean.mount = persona.mount === 'rw' ? 'rw' : 'ro'
    if (persona.leadByDefault === true) clean.leadByDefault = true
    next.personas[k] = clean
  } else {
    return { ok: false, error: `unknown persona op "${op}"` }
  }
  try { parseRoster(next, {}) } catch (e) { return { ok: false, error: String(e?.message || e) } }
  return { ok: true, roster: next }
}

function ROLES_OK(role, customPersonas) {
  // Mirrors personas.ROLES keys without importing the whole map; a team.json custom persona key counts
  // as known too. Unknown roles are allowed (warned + treated generically).
  const r = ROLE_ALIASES[role] || role
  if (customPersonas && Object.prototype.hasOwnProperty.call(customPersonas, r)) return true
  return ['architect', 'engineer', 'critic', 'adversary', 'ultracritical', 'user-defender', 'researcher', 'tester', 'designer', 'sound-designer', 'composer'].includes(r)
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
