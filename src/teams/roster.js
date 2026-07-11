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
import { assertCageAllowed } from './cage.js'
import { canonicalMountSource } from '../mount-guard.js'   // #49: realpath-canonical territory validation (legible, symlink-safe)
import { resolveMemberRepo } from './repo-auth.js'   // #49 Inc 2: gate an explicit member.repo against the org's human-authorized set

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

// #65: org/team NAMES pass through this single parse chokepoint. Unlike a free-form chat body (#63-A, which
// must legitimately contain < ' & → render-safe by construction), a NAME has no legitimate need for any
// HTML/JS metacharacter — so ALLOW-LIST the readable set and reject everything else. An allow-list is
// complete BY CONSTRUCTION: quotes / <>& / parens / ; { } / backslash / backtick AND the Unicode line-
// terminators (U+2028/U+2029/U+0085/NBSP/etc) are all rejected because none are \p{L}/\p{N}/the literal
// space/`. _ -` — no deny-list to leave a gap. \p{L} + the u flag accepts readable accented / non-ASCII
// names ("My Project", "Équipe Alpha", "项目" — #38), unlike the strict member-name SAFE_NAME.
// CRITICAL: the whitespace allowance is a LITERAL ' ' (U+0020), NEVER \s — \s re-admits U+2028/U+2029/nbsp
// and would leak the guard. Must start with a letter/digit (no leading space/punct). Length-capped.
const SAFE_PROJECT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u
export function assertSafeProjectName(name, kind = 'project') {
  const s = String(name == null ? '' : name).trim()
  if (!s) throw new Error(`${kind} name must not be empty`)
  if (s.length > 64) throw new Error(`${kind} name is too long (max 64 characters)`)
  if (!SAFE_PROJECT_NAME.test(s)) {
    throw new Error(`${kind} name ${JSON.stringify(name)} is invalid — use letters, digits, spaces, and . _ - (start with a letter or digit; no quotes, angle brackets, ampersand, parentheses, braces, semicolons, backslashes, backticks, or control characters). Rename it.`)
  }
  // #49: the `-solo-<8 hex>` suffix is RESERVED — it names an auto-derived solo session's org (solo.js
  // soloOrgId). A team.json whose explicit org/project/team name wore it would be byte-identical to some
  // repo's solo org and, via defineOrg's redefine-prune, could silently steal that session's members. So
  // make the "structurally distinct" claim ENFORCED here, at the single name chokepoint, not conventional.
  if (RESERVED_SOLO_ORG_RE.test(s)) {
    throw new Error(`${kind} name ${JSON.stringify(name)} is reserved — the "-solo-<hash>" suffix names an auto-derived solo session's org (#49). Choose another name.`)
  }
  return s
}
// The reserved solo-org suffix (see assertSafeProjectName + solo.js). Kept here, the name chokepoint, so
// both the strict validator and the benign sanitizer below neutralize it (no import cycle with solo.js).
export const RESERVED_SOLO_ORG_RE = /-solo-[0-9a-f]{8}$/i
// For the BENIGN fallback only (a local repo basename, NOT the team.json attack vector): strip disallowed
// chars so a weird local directory name can't break — never throws (a derived default shouldn't fail
// launch). Also strip a trailing reserved solo suffix so even a repo literally named `x-solo-<hex>` can't
// have its derived TEAM org collide with a solo org (closes the benign half of the squat).
export function sanitizeProjectName(s) {
  const cleaned = String(s == null ? '' : s).replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/^[^\p{L}\p{N}]+/u, '').replace(RESERVED_SOLO_ORG_RE, '').trim()
  return cleaned.slice(0, 64)
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

// modelB (Inc 3, Site 2): the Model-B parse — every member MUST carry an explicit, human-authorized repo (the
// authorized-set is the SOLE gate; no org-root default). Threaded ONLY on the team launch path (materializeRoster,
// Site 5) and NEVER for solo (soloRoster builds its org directly and never calls parseRoster), so modelB here IS
// `storeMode && team && !solo` by construction. Absent (default false) → legacy parse, byte-identical.
export function parseRoster(input, { repo, rng, modelB = false } = {}) {
  const data = typeof input === 'string' ? JSON.parse(input) : input
  if (!data || typeof data !== 'object') throw new Error('roster: not an object')
  const repoPath = data.repo || repo || process.cwd()
  // #65: validate the EXPLICIT project/org name (the malicious-team.json XSS vector) at this chokepoint;
  // the benign basename fallback (a local dir, not attacker-controlled) is sanitized rather than thrown on.
  const explicitName = data.project || data.org
  const org = explicitName ? assertSafeProjectName(explicitName, 'project') : (sanitizeProjectName(basename(repoPath)) || 'org')
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
    const teamName = t.name ? assertSafeProjectName(t.name, 'team') : `team-${teams.length + 1}`   // #65: validate explicit team names
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
      // #49: live-ness is a BACKEND capability (claude has the MCP channel; codex doesn't), NOT a role
      // property — so a claude member is ALWAYS live, never demoted to worker by a role's tier (incl. the
      // generic-fallback 'worker' an undefined/custom role would otherwise carry). Media roles already
      // resolved a non-claude backend above (isMediaRole branch) → worker. def.tier is no longer consulted
      // here (it remains role-intent documentation only).
      const tier = LIVE_BACKENDS.has(backend) ? 'live' : 'worker'
      // #49 (4b): a member's `cage` must name an allow-listed, fully-honorable profile AND ride a backend
      // whose transport can enforce it — rejected HERE, the parse chokepoint (not in execWorker), so a cage
      // the system can't fully honor can never launch behind a "caged" label. Same shape as the name guards.
      let cage = null
      if (m.cage != null && m.cage !== false) {
        const chk = assertCageAllowed(m.cage, backend)
        if (!chk.ok) throw new Error(`member ${JSON.stringify(m.name || role)}: ${chk.error}`)
        cage = String(m.cage)
      }
      const mount = m.mount || def.mount
      const territory = resolveTerritory(m.territory, teamTerritory)
      const lead = m.lead === true
      // #49 (Inc 2): the member's repo. Default = the team's OWN repo (unchanged for existing rosters, which
      // set no member.repo). An EXPLICIT member.repo (multi-repo) must be HUMAN-authorized — resolveMemberRepo
      // returns the canonical authorized path or THROWS, so a cross-repo member is refused at PARSE until a
      // human adds that repo to the org's set (member.repo-differs can never ship an unauthorized mount). Store
      // the RETURNED canonical repo — so all five consumers (mount, worker mount, worker-log, asset write, the
      // .env secret read) inherit an already-authorized value, gated once at the mint, not at each door.
      // The DEFAULT keeps the RAW repoPath (not realpath'd) — today's behavior, so no config-volume-key shift
      // for existing symlinked-repo members (Pierre #3); only an explicit cross-repo gets the canonical
      // authorized path (and those are new, no volume to re-login). Surface an unauthorized repo LEGIBLY with
      // the member handle (Pierre #2), not a raw throw.
      // ASYMMETRY — do NOT "fix" the sidestep, it preserves `mrc ~` (Pierre): the OWN repo trusts the human's
      // LAUNCH CHOICE (they typed the path — they may mount their own $HOME if they chose to), so the default
      // skips resolveMemberRepo's broad-guard. A CROSS-REPO member.repo is different — a summoned member must
      // never reach into $HOME on its own — so it goes through resolveMemberRepo, where the broad-guard fires
      // AND it must be human-authorized. $HOME as the ORG repo = allowed (the user's choice); $HOME as a
      // CROSS-REPO member.repo = refused. Routing the default through the broad-guard would break `mrc ~`.
      let memberRepo
      if (modelB) {
        // Model B: NO org-root default. Every member picks its OWN repo, gated by the SOLE-gate resolveMemberRepo
        // (own-repo grant deleted) — missing repo → throw, unauthorized → throw, authorized → canonical realpath.
        // There is no `= repoPath` fallback: identity is the neutral anchor (Site 4), not a mounted org repo.
        try { memberRepo = resolveMemberRepo(repoPath, m.repo, org, { modelB: true }) }
        catch (e) { throw new Error(`member @${handle}: ${e.message || e}`) }
      } else {
        // LEGACY (unchanged): default = the team's OWN repo (own-repo grant sidesteps the broad-guard for `mrc ~`);
        // an EXPLICIT differing member.repo goes through resolveMemberRepo (human-authorized-set or throw).
        memberRepo = repoPath
        if (m.repo != null && m.repo !== '' && String(m.repo) !== String(repoPath)) {
          try { memberRepo = resolveMemberRepo(repoPath, m.repo, org) }
          catch (e) { throw new Error(`member @${handle}: ${e.message || e}`) }
        }
      }
      // Resolved persona for this member: label/mandate/leadByDefault from the (custom or built-in)
      // def, with the EFFECTIVE mount + backend-derived tier folded in. buildPersona consumes this.
      const personaDef = { label: def.label, mandate: def.mandate, mount, tier, leadByDefault: def.leadByDefault === true, custom: !!def.custom }
      return {
        id: `${slug(org)}:${slug(teamName)}:${handle.replace('/', '-')}`,
        first, backend, handle,
        role, roleLabel: def.label,
        team: teamName, lead, tier, territory, mount, personaDef, repo: memberRepo,
        // #49 multi-repo (Mouth B): stamp crossRepo AT THE MINT — the one place BOTH roots are visible (the team
        // repoPath + the resolved memberRepo). It then rides the member object into EVERY consumer: both blob
        // constructors (memberArgv for a live member AND room-daemon's worker blob) and execWorker's config-vol
        // keying — so a cross-repo member is org-scoped on the LIVE and WORKER paths alike. Computing it only in
        // memberArgv left the worker blob born without it → an un-org-scoped, cross-org-colliding config vol.
        // Model B: EVERY member is org-scoped (there is no org-root proxy — identity is the neutral anchor), so
        // crossRepo is forced true → the org-scoped LIVE/WORKER paths (mrc.project labels, memberArgv, worker blob)
        // apply uniformly. (Config-vol keying already flips on storeMode, Inc 2, independent of crossRepo.)
        crossRepo: modelB || String(memberRepo) !== String(repoPath),
        ...(cage ? { cage } : {}),
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
  // #49 (Pierre): a rw member's territory must realpath-resolve WITHIN the repo — surfaced LEGIBLY here, both
  // an escape AND a missing territory as a hard ERROR, rather than a raw ENOENT stack trace at mount time.
  // MECHANISM-DERIVED exemption (not a role list): error only for the members whose LAUNCH MOUNTS the territory
  // via memberWorkspaceVolumes → canonicalMountSource (which THROWS on a missing source) — i.e. every rw
  // sub-tree member EXCEPT media-makers, who generate HOST-SIDE via media.js → canonicalWriteTarget
  // (tolerate-and-CREATE a missing dir, no container mount). Keyed on isMediaRole — the SAME predicate that
  // routes a member to media.js vs the container mount — so a new host-side generator is auto-exempt and a new
  // container role auto-requires its territory (no list to drift). The TESTER is live+rw and MOUNTS, so it is
  // NOT exempt (it sits in the OVERLAP-exempt set for a DIFFERENT reason — contention, not existence). Only
  // when the repo exists on disk (a validate against an in-memory norm with no real repo skips it).
  if (norm.repo && existsSync(norm.repo)) {
    for (const m of norm.members) {
      if (m.mount === 'rw' && m.territory && m.territory !== '.' && !isMediaRole(m.role)) {
        try { canonicalMountSource(norm.repo, m.territory) }
        catch (e) {
          const msg = String(e?.message || e)
          if (/escapes the repo|filesystem root/.test(msg)) errors.push(`member @${m.handle}: territory "${m.territory}" ${msg.replace(/^mount source "[^"]*" /, '')}`)
          else errors.push(`member @${m.handle}: territory "${m.territory}" not found in the repo — its container mounts it and the mount fails closed on a missing source; create it (or fix the roster) before launch`)
        }
      }
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
  // #49-SEC (Mouth A): source a roster ONLY from RO-to-members locations (repo root). Deliberately NOT
  // <repo>/.mrc/team.json — `.mrc` is the rw member mount, so a member can PLANT a team.json there and steer any
  // findRoster consumer (notably the worker exec's memberWorkspaceVolumes → its container mount). Nothing WRITES
  // that path (team.json is always written at the repo root by writeTeamFile), so it was a pure member-writable
  // discovery hole, not a real config location. Removing it closes the manual `mrc team exec` mouth of the
  // member-writable-roster class (the daemon's _worker-exec is closed separately by threading --member-def).
  return [join(repo, 'team.json'), join(repo, 'mrc-team.json')]
}
export function findRoster(repo) {
  return rosterCandidates(repo).find((p) => existsSync(p)) || null
}
