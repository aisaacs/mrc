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
import { realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
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

// Realpath a repo path (the FEED — never trust the caller's spelling) and BROAD-GUARD it: a repo that resolves
// to the filesystem root or the home dir is never a legitimate team repo (far too broad a mount + secret
// surface). Fuzzier roots (a project-root's parent) stay policy for the human's add decision; these two
// unambiguous ones are refused in the primitive so a forgotten upstream check can't authorize `/` or `~`.
function resolveRepoOrThrow(repoPath, label = 'repo') {
  const real = realpathSync(String(repoPath))
  if (real === sep) throw new Error(`${label} resolves to the filesystem root ("/") — never a legitimate team repo`)
  if (real === realpathSync(homedir())) throw new Error(`${label} resolves to the home directory — too broad to authorize; point at a specific project`)
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
  let real; try { real = realpathSync(String(repoPath)) } catch { real = String(repoPath) }
  const set = loadAuthorizedRepos(org)
  if (!set.delete(real) && !set.delete(String(repoPath))) return false
  const p = authPath(org)
  mkdirSync(authDir(), { recursive: true })
  const tmp = `${p}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify([...set], null, 2))
  renameSync(tmp, p)
  return true
}

// THE MINT GATE (Inc 2 calls this from parseRoster): resolve a member's requested repo to an authorized,
// realpath-canonical path, or THROW. Accept iff the resolved request === the resolved ORG repo (the tautological
// own-repo grant) OR it's in the org's human-authorized set. Returns the canonical repo to store in the norm,
// so every downstream consumer (mount, worker mount, worker-log, asset write, .env secret read) inherits an
// already-authorized value. `requested` null/empty/=== the org repo → the own-repo grant (the common case).
export function resolveMemberRepo(orgRepo, requested, org) {
  // Broad-guard the IMPLICIT own-repo grant ONLY (Pierre #3): the own-repo grant is the sole AUTO-authorization
  // (accepts realpath(orgRepo) with no human confirm), so a repo symlinked to `/` or `$HOME` must not
  // auto-authorize the world. The explicit set needs no broad-guard — a human vouched for those, and
  // addAuthorizedRepo already refuses `/`/`$HOME` at the add, so the set can never contain them.
  const orgReal = resolveRepoOrThrow(orgRepo, 'org repo')
  if (requested == null || requested === '' || requested === orgRepo || requested === orgReal) return orgReal
  // Realpath the FEED (canonical compare) but do NOT broad-guard the request — the set-check is its gate. A
  // request that resolves to `/`/`$HOME` simply isn't in the set → refused there, no separate denylist to drift.
  let reqReal
  try { reqReal = realpathSync(String(requested)) } catch { throw new Error(`member repo "${requested}" not found on disk`) }
  if (reqReal === orgReal) return orgReal   // a different spelling of the org repo → still the own-repo grant
  if (loadAuthorizedRepos(org).has(reqReal)) return reqReal
  throw new Error(`member repo "${requested}" (resolves to ${reqReal}) is not authorized for org "${org}" — a human must add it to the team's repos first; a session can never authorize a repo, only request one.`)
}

export const _authPathForTest = authPath
