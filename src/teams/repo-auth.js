// repo-auth.js (#49 multi-repo, Inc 1) — the per-org authorized-repo set + the resolveMemberRepo MINT gate.
//
// A team is ONE org whose members may live in DIFFERENT repos (option A). But a session choosing member.repo
// is a session choosing what slice of the host filesystem to MOUNT and READ SECRETS FROM — media.js reads
// `member.repo/.env` for the API key (Pierre: member.repo has FIVE consumers, one a secret read, no mount-guard
// covers it). So the repo axis is HUMAN-authorized, never session-arbitrary, and the gate is at the MINT
// (parseRoster resolves member.repo through resolveMemberRepo ONCE; all consumers inherit the authorized,
// realpath-canonical value) — not at each of the five doors.
//
// PER-ORG, not global (Pierre): a global set is a cross-org privilege leak — authorizing repo-X for org-A would
// make it org-B's capability too, the same isolation the engine's line-345 floor enforces. The implicit
// own-repo grant is tautological (in the unified model a session's repo IS its org's repo), so it's per-org by
// construction. Cross-repo (a member in a DIFFERENT repo) is always an explicit HUMAN add to THAT org's set.
//
// WRITE-ISOLATION: the record lives HOST-ONLY (~/.local/share/mrc/authorized-repos/, never mounted into any
// container) and is mutated ONLY by addAuthorizedRepo — the human control-plane path (dashboard CSRF / CLI),
// NEVER a session-callable channel verb. A container can't read it (unmounted) and can't grow it (no verb). A
// session may REQUEST a repo (an @user inbox item); the AUTHORIZATION is a human act. Escalate-by-asking only.
import { realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { homedir } from 'node:os'

const authDir = () => join(homedir(), '.local', 'share', 'mrc', 'authorized-repos')
// KEY ON THE RAW ORG, INJECTIVELY (Pierre): the per-org set is a SECURITY record, so its key must be a
// bijection — a lossy `slug(org)` collapses distinct orgs (`acme.prod`/`acme_prod`/`Acme-Prod` → `acme-prod`)
// onto ONE file, sharing their authorized-set = the exact cross-org privilege leak per-org exists to prevent,
// and attacker-triggerable (name your org to slug-collide with a victim's). The engine keys isolation on the
// RAW org (exact string); the record must agree. Hex-encode the raw utf8 org — provably injective (a bijection,
// no hash-collision reasoning needed) and reversible (hex-decode to debug). `slug` is fine for a display label,
// NEVER for a security-record key.
const authPath = (org) => join(authDir(), `${Buffer.from(String(org), 'utf8').toString('hex')}.json`)

// Expand a LEADING `~`/`~/` or `$HOME` to the home dir BEFORE realpath — a human types `~/code/app` (in the CLI or
// the create form) but realpathSync treats `~` as a literal char → ENOENT → a confusing "not found". Only a leading
// `~`/`~/`/`$HOME` is expanded (never `~user`), so it's a SPELLING normalization on the feed, not a new authorization
// path: the realpath + broad-guards downstream are unchanged — a bare `~`/`$HOME` still resolves to the home dir and
// is refused by resolveRepoOrThrow (or allowed only as the trusted `mrc ~` root), exactly as before.
export function expandHome(p) {
  const s = String(p)
  if (s === '~' || s.startsWith('~/')) return join(homedir(), s.slice(1))
  if (s === '$HOME' || s.startsWith('$HOME/')) return join(homedir(), s.slice(5))
  return s
}

// Realpath a repo path (the FEED — never trust the caller's spelling) and BROAD-GUARD it: a repo that resolves
// to the filesystem root or the home dir is never a legitimate team repo (far too broad a mount + secret
// surface). Fuzzier roots (a project-root's parent) stay policy for the human's add decision; these two
// unambiguous ones are refused in the primitive so a forgotten upstream check can't authorize `/` or `~`.
function resolveRepoOrThrow(repoPath, label = 'repo') {
  const real = realpathSync(expandHome(repoPath))
  if (real === sep) throw new Error(`${label} resolves to the filesystem root ("/") — never a legitimate team repo`)
  if (real === realpathSync(homedir())) throw new Error(`${label} resolves to the home directory — too broad to authorize; point at a specific project`)
  return real
}

// The canonical form of a TRUSTED org root (a CLI argv the human typed, or a picker create). Unlike
// resolveRepoOrThrow it ALLOWS `$HOME` (the `mrc ~` exemption — the human's explicit launch choice; only `/` is
// never legitimate) and requires the path to EXIST (realpathSync throws ENOENT → throw-closed). SHARED by
// resolveOrgRoot's trusted first-pin AND recordActivatedRoot so pin and activate can NEVER disagree about a value
// (the $HOME pin-but-can't-activate contradiction Pierre found): both accept exactly the same trusted roots.
function canonicalTrustedRoot(repoPath, label = 'root') {
  const real = realpathSync(expandHome(repoPath))   // ~ / $HOME expanded first; throws ENOENT on a non-existent path → throw-closed
  if (real === sep) throw new Error(`refusing to pin the filesystem root ("/") as a project ${label} — never a legitimate project`)
  return real
}

// The org's authorized-repo set (realpaths). A missing/unreadable record = the EMPTY set (fail-closed: nothing
// cross-repo is authorized until a human adds it — so a cross-repo member is refused by default).
export function loadAuthorizedRepos(org) {
  try {
    const arr = JSON.parse(readFileSync(authPath(org), 'utf8'))
    return new Set(Array.isArray(arr) ? arr.map(String) : [])
  } catch { return new Set() }
}

// The union of EVERY org's authorized repos (canonical realpaths), across the whole store. Used ONLY by the
// dashboard repo-picker to offer "recent (other projects)" quick-picks so a FRESH org (empty own set) isn't
// typed-blind. This is NOT a security relaxation: every path returned already passed an authorize gate to be in
// some org's set (all vouched), and picking one still routes through the per-org, cap-gated addAuthorizedRepo —
// visibility ≠ grant. Single-principal dashboard (one owner's orgs), so surfacing the owner's own paths to the
// owner is zero marginal disclosure; the caller LABELS them "other projects" to close the wrong-org foot-gun.
export function listAllAuthorizedRepos() {
  const out = new Set()
  let names
  try { names = readdirSync(authDir()) } catch { return [] }   // no store yet → empty
  for (const f of names) {
    if (!f.endsWith('.json')) continue
    try { const arr = JSON.parse(readFileSync(join(authDir(), f), 'utf8')); if (Array.isArray(arr)) for (const r of arr) out.add(String(r)) } catch {}
  }
  return [...out]
}

// Add a repo to an org's authorized set — the HUMAN control-plane mutation ONLY. Realpaths + broad-guards
// before storing, so the set holds canonical, non-pathological paths and the read side compares canonical to
// canonical (the realpath-the-feed lesson, at the authorize step). Atomic write. Returns the stored realpath.
export function addAuthorizedRepo(org, repoPath) {
  const real = resolveRepoOrThrow(repoPath, 'authorized repo')
  const set = loadAuthorizedRepos(org)
  set.add(real)
  const p = authPath(org)
  mkdirSync(authDir(), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify([...set], null, 2))
  renameSync(tmp, p)
  return real
}

// Remove a repo from an org's set (human control-plane; e.g. the dashboard "remove repo"). Idempotent.
export function removeAuthorizedRepo(org, repoPath) {
  let real; try { real = realpathSync(expandHome(repoPath)) } catch { real = String(repoPath) }
  const set = loadAuthorizedRepos(org)
  if (!set.delete(real) && !set.delete(String(repoPath))) return false
  const p = authPath(org)
  mkdirSync(authDir(), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify([...set], null, 2))
  renameSync(tmp, p)
  return true
}

// THE MINT GATE (parseRoster calls this): resolve a member's requested repo to an authorized, realpath-canonical
// path, or THROW. Returns the canonical repo to store in the norm, so every downstream consumer (mount, worker
// mount, worker-log, asset write, .env secret read) inherits an already-authorized value.
//   • LEGACY: accept iff the resolved request === the resolved ORG repo (the own-repo grant) OR it's in the set.
//   • MODEL B (Inc 3): the authorized-set is the SOLE gate. NO own-repo-grant — there is no org repo in Model B
//     (identity is the neutral anchor, not a mounted repo), so every member repo must be EXPLICIT and in the org's
//     human-authorized set, or THROW. There is no `return orgReal` path: every return reaches
//     loadAuthorizedRepos(org).has(...) or a throw. This is the whole security delta — the pin's re-root protection
//     and activation's deferral both collapse into this one gate (a repo is mounted/`.env`-read ONLY once a human
//     CSRF+capOk act put it in the set). modelB is passed ONLY on the team-parse path (never solo: a store-capable
//     image running solo keeps its own-repo default, so the flag is `modelB && team && !solo`, set in parseRoster).
export function resolveMemberRepo(orgRepo, requested, org, { modelB = false } = {}) {
  if (modelB) {
    // Model B: SOLE-gate. No own-repo-grant, no orgRepo return — request required, realpath, set-check or throw.
    if (requested == null || requested === '') throw new Error(`Model B: an explicit repo is required for a member of org "${org}" — every agent picks its own authorized repo (there is no org-root default to fall back to).`)
    let reqReal
    try { reqReal = realpathSync(expandHome(requested)) } catch { throw new Error(`member repo "${requested}" not found on disk`) }
    if (loadAuthorizedRepos(org).has(reqReal)) return reqReal
    throw new Error(`member repo "${requested}" (resolves to ${reqReal}) is not authorized for org "${org}" — a human must add it (dashboard Authorize / \`mrc team … repos add\`); a session can request a repo, never authorize one.`)
  }
  // LEGACY (unchanged) — own-repo grant OR set. Broad-guard the IMPLICIT own-repo grant ONLY (Pierre #3): the
  // own-repo grant is the sole AUTO-authorization (accepts realpath(orgRepo) with no human confirm), so a repo
  // symlinked to `/` or `$HOME` must not auto-authorize the world. The explicit set needs no broad-guard — a human
  // vouched for those, and addAuthorizedRepo already refuses `/`/`$HOME` at the add, so the set can't contain them.
  const orgReal = resolveRepoOrThrow(orgRepo, 'org repo')
  if (requested == null || requested === '' || requested === orgRepo || requested === orgReal) return orgReal
  // Realpath the FEED (canonical compare) but do NOT broad-guard the request — the set-check is its gate. A
  // request that resolves to `/`/`$HOME` simply isn't in the set → refused there, no separate denylist to drift.
  let reqReal
  try { reqReal = realpathSync(expandHome(requested)) } catch { throw new Error(`member repo "${requested}" not found on disk`) }
  if (reqReal === orgReal) return orgReal   // a different spelling of the org repo → still the own-repo grant
  if (loadAuthorizedRepos(org).has(reqReal)) return reqReal
  throw new Error(`member repo "${requested}" (resolves to ${reqReal}) is not authorized for org "${org}" — a human must add it to the team's repos first; a session can never authorize a repo, only request one.`)
}

// GUARD #1 (dashboard-ux command-and-control floor) — the org ROOT is pinned WRITE-ONCE, and a first-pin is a
// PRIVILEGED act. A project's root repo is identity-defining (project = org = intent) and STRICTLY BROADER than a
// member-host repo: it is the default rw `/workspace` mount AND the `.env`-read root for every default-repo member
// (team.js). So it is NOT folded into the cross-repo MEMBER authorized-set (resolveMemberRepo) — a flat set can't
// tell "may host a member" from "may be the org ROOT", and unifying them promotes a member-eligible repo into a
// root (over-grant). Instead: the root is set once at create and IMMUTABLE thereafter, never re-read from a later
// wire frame. `pinnedRoot` = the org's already-pinned root (a realpath) or null/'' for a never-pinned org.
//   • EXISTING pin → the request MUST realpath-match it, whoever asks (write-once beats trust; a differing root is
//     a new project, created explicitly — never a wire mutation). This closes the defineOrg re-root bypass
//     STRUCTURALLY, so a persisted/forged def.repo can't promote a new path to the team's rw + `.env`-read root.
//   • FIRST pin → only a TRUSTED origin (a real human launch: a CLI argv the human typed, or the CSRF-guarded
//     human-picker create) may establish a root. An UNTRUSTED wire frame (a raw defineOrg over the control socket)
//     can NEVER first-pin — so it can't read/mount a wire-chosen path before a human authorized it. NOTE: this is
//     the VALUE gate; the daemon must ALSO hold the define-time SIDE EFFECTS (ensureTgForOrg's `.env` read +
//     bridge, writeTeamFile) inert until a trusted ACTIVATE — pinning and activating are separate (see the daemon).
export function resolveOrgRoot(pinnedRoot, requestedRepo, { trusted = false } = {}) {
  if (pinnedRoot != null && pinnedRoot !== '') {
    let pinnedReal; try { pinnedReal = realpathSync(String(pinnedRoot)) } catch { pinnedReal = String(pinnedRoot) }
    let reqReal; try { reqReal = realpathSync(String(requestedRepo)) } catch { reqReal = null }
    if (reqReal !== pinnedReal) throw new Error(`project is rooted at ${pinnedReal}; refusing to re-root it to "${requestedRepo}" — a different root is a different project (create a new one, don't re-point this one).`)
    return pinnedReal
  }
  if (!trusted) throw new Error(`no root is pinned for this project and an untrusted define cannot establish one — a root is set by a human act (picker create / CLI argv), never a raw wire frame`)
  return canonicalTrustedRoot(requestedRepo, 'root')   // trusted first-pin: realpath, $HOME allowed (mrc ~), `/` refused, ENOENT throws
}

// The write-once PIN RECORD + the CHOKEPOINT every org-root ingress calls. resolveOrgRoot is only as strong as
// its caller passing the stored pin (Pierre): any ingress that passed `pinnedRoot=null` for an already-pinned org
// on a trusted path would drop into first-pin and RE-ROOT freely. So the pin is loaded HERE, internally — no
// caller (defineOrg / launchteam / relaunchmember / activate / boot-reload) ever handles it, so none can forget
// it. The record is DEDICATED + host-only (never the mutable orgDef, which defineOrg overwrites wholesale) and
// hex-keyed (injective). It's persisted WRITE-ONCE under concurrency via O_EXCL (`wx`): two racing trusted
// first-pins can't both win with different roots — the create loser (EEXIST) re-loads and validates through the
// EXISTING-pin branch (match-or-throw), never proceeding on its own resolve.
const rootDir = () => join(homedir(), '.local', 'share', 'mrc', 'org-roots')
const rootPath = (org) => join(rootDir(), `${Buffer.from(String(org), 'utf8').toString('hex')}.json`)

export function pinnedOrgRoot(org) {
  try { const v = JSON.parse(readFileSync(rootPath(org), 'utf8')); return (typeof v === 'string' && v) ? v : null } catch { return null }   // missing/torn → null (a torn crash-write is re-pinnable, never a silent re-root of a live project)
}

export function resolveOrgRootForOrg(org, requestedRepo, { trusted = false } = {}) {
  const pin = pinnedOrgRoot(org)
  const root = resolveOrgRoot(pin, requestedRepo, { trusted })   // existing-pin → match-or-throw; else trusted-only first-pin (throws untrusted)
  if (pin) return root                                           // already pinned + matched → nothing to persist
  mkdirSync(rootDir(), { recursive: true })
  try { writeFileSync(rootPath(org), JSON.stringify(root), { flag: 'wx' }); return root }   // atomic create-only (O_EXCL)
  catch (e) {
    if (e && e.code === 'EEXIST') return resolveOrgRoot(pinnedOrgRoot(org), requestedRepo, { trusted })   // lost the race → validate against the winner's pin
    throw e
  }
}

// Clear an org's pin — the removeorg (deliberate human delete) path, so a delete→recreate can re-pin a NEW root
// (a human act, never a wire re-root of a live project). Idempotent.
export function clearOrgRoot(org) { try { unlinkSync(rootPath(org)) } catch {} }
export const _rootPathForTest = rootPath

// GUARD #1 — the ACTIVATION record. Pinning a root (resolveOrgRoot) is separate from ACTIVATING it: the
// define-time consumers of def.repo (the `.env` read + Telegram bridge, writeTeamFile) fire ONLY after a trusted
// activate, never at a bare define or boot-reload. This is the authorized-repos primitive applied to the ROOT: a
// per-org host-only set of CONFIRMED REALPATHS, hex-keyed (injective — a lossy slug would let `acme.prod` inherit
// `acme_prod`'s activation). Activation is a VALUE match — `isActivatedRoot` iff realpath(def.repo) is recorded —
// NOT a name-keyed boolean, so a delete→recreate to a different root can never inherit activation even if a purge
// is missed (the removeorg-doesn't-purge vector). CLI `team up` is a trusted local-TTY frame → it records; a
// browser create is CSRF-only → it records only on an explicit human activate gesture on the pinned root.
const activatedDir = () => join(homedir(), '.local', 'share', 'mrc', 'activated-roots')
const activatedPath = (org) => join(activatedDir(), `${Buffer.from(String(org), 'utf8').toString('hex')}.json`)

export function isActivatedRoot(org, repoPath) {
  let real; try { real = realpathSync(String(repoPath)) } catch { return false }   // a root that isn't on disk can't be an activated one
  try {
    const arr = JSON.parse(readFileSync(activatedPath(org), 'utf8'))
    return Array.isArray(arr) && arr.map(String).includes(real)
  } catch { return false }   // missing/unreadable record → NOT activated (fail-closed: a never-confirmed root stays inert)
}

// Record a root as human-activated for an org (a TRUSTED act: CLI `team up`, or the dashboard's explicit activate
// confirm). ALIGN-RESTRICTIVE with the pin (Pierre): the pin PERMITS a broad root ($HOME) because that's the MOUNT
// choice (`mrc ~` mounting home as /workspace is the human's call), but ACTIVATE is a DIFFERENT capability — it
// unlocks the define-time `.env` read + Telegram bridge + `.mrc` write. Auto-reading the user's GLOBAL `$HOME/.env`
// (cross-project cloud creds) would be the fattest secret surface on the box — and a browser create is "trusted"
// only via CSRF, so a `$HOME` root is NOT always a CLI choice. So a broad root ($HOME or `/`) is SKIPPED gracefully
// (returns null = not activated, NEVER throws → fixes the `mrc team up ~` break without reading `~/.env`); the
// daemon logs "home-rooted — not auto-activated by design". Returns the canonical realpath if recorded, else null.
export function recordActivatedRoot(org, repoPath) {
  let real; try { real = realpathSync(String(repoPath)) } catch { return null }             // non-existent → not activated (fail-safe)
  if (real === sep || real === realpathSync(homedir())) return null                          // BROAD root: pinnable+mountable, but never auto-read its `.env`
  let set; try { set = new Set((JSON.parse(readFileSync(activatedPath(org), 'utf8')) || []).map(String)) } catch { set = new Set() }
  set.add(real)
  const p = activatedPath(org)
  mkdirSync(activatedDir(), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify([...set], null, 2))
  renameSync(tmp, p)
  return real
}

// Purge an org's activation record — the removeorg hygiene path. Idempotent. (Value-binding means activation
// wouldn't inherit across a delete→recreate even without this, but purge anyway so stale records don't accrete.)
export function clearActivatedRoots(org) {
  try { unlinkSync(activatedPath(org)) } catch {}
}

export const _activatedPathForTest = activatedPath
export const _authPathForTest = authPath

// MODEL B — the org's NEUTRAL IDENTITY ANCHOR: a host-only, NEVER-MOUNTED directory keyed by the org NAME
// (hex-injective, same key + same host-only class as org-roots/ and activated-roots/). In Model B this IS the
// project's identity — tied to NO agent's repo — and it holds identity + the launch.log + the per-project Telegram
// `.env` (a SECRET). It MUST NOT be a container mount: #5's memory store IS mounted into member containers, so if
// the anchor were #5's store root, ANY member container could read the project's Telegram token (the def.repo/.env
// -read crack recreated). So this is a SIBLING to #5's store with the OPPOSITE mount property — anchor UNMOUNTED
// (secrets safe), store slices mounted (memory). Same hex(org) key for identity consistency, distinct tree.
// The pin AND activation both retire in Model B (subsumed by the authorized-set), so the anchor needs neither a
// write-once pin nor an activation gate: it's a DERIVED path (you can't re-point a hash of a validated org name),
// immutable by derivation. hex-keyed so a lossy slug can't let `acme.prod` collide with `acme_prod`.
const orgAnchorRoot = () => join(homedir(), '.local', 'share', 'mrc', 'org-anchors')
export function orgAnchorDir(org) {
  return join(orgAnchorRoot(), Buffer.from(String(org), 'utf8').toString('hex'))
}
export const _orgAnchorRootForTest = orgAnchorRoot
