// Solo onramp (#49, piece 4a) — a "team of one" derived with ZERO roster ceremony.
//
// `mrc <repo> --solo` registers a plain Claude session as a single engine member so it inherits the
// dashboard console, the @user inbox, and multi-room membership for free — while behaving exactly like
// today's solo session until the human pulls someone in. This module is the PURE derivation: given a
// repo path it produces a normalized org (the same shape parseRoster emits) that orgDef/defineOrg/
// memberLaunch already consume. The launch orchestration (born-detachable dtach+ttyd, fallback to a
// foreground `docker run -it`) lives in the launcher; this stays filesystem-free and unit-testable.
//
// DESIGN (Pierre-audited, adversary-7177993db5):
//  • Deterministic identity, per-repo. The org id folds a short hash of the ABSOLUTE repo path, so two
//    repos that share a basename never collide (which would merge in defineOrg's redefine-prune and
//    silently steal each other's members) and a resumed solo session rebinds to the SAME org — the
//    memberSessionId discipline (sha1(org\0handle)) the teams path already relies on. The handle is the
//    reserved constant `you/claude` (never drawn from the name pool), so sha1 + the repo#handle config
//    volume are stable across every run. A singleton, so NO slot pool (that is the summoned-adversary
//    story, a different member with a different identity strategy).
//  • The org id is ALSO namespaced `-solo-<hash>`, structurally distinct from any team org (basename or
//    explicit `project`), so running --solo in a repo that ALSO has a team.json can never prune the team.
//  • A DEDICATED solo room (`kind:'solo'`), NOT the roster's leads-room derivation. defineOrg seats @user
//    by membership regardless of kind, so `[you/claude, @user]` reaches the inbox without making the
//    human "lead of a team of one" (which would inherit the leads-room routing special-cases). `kind:'solo'`
//    hits neither the `consult` nor the `leads` branch in the engine → generic directed routing, with the
//    2-member fallback delivering an un-@mentioned line to @user (the delivery fix in room-engine.js).
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { makeHandle } from './names.js'
import { sanitizeProjectName } from './roster.js'

// The reserved solo identity. `you` is reserved OUT of the name pool (names.js RESERVED_FIRST_NAMES) so a
// team member can never be auto-named `you` and collide with a solo member's handle.
export const SOLO_FIRST = 'you'
export const SOLO_BACKEND = 'claude'
export const SOLO_HANDLE = makeHandle(SOLO_FIRST, SOLO_BACKEND)   // 'you/claude'
export const SOLO_TEAM = 'solo'
export const SOLO_ROLE = 'solo'

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x'

// Resolve to the repo's REAL identity before deriving anything from it: realpath collapses symlinks and
// bind-mounts so the SAME repo opened as `/home/me/proj` or `/home/me/link-to-proj` yields ONE org (the
// rebind-stability guarantee is repo-identity-deep, not path-string-deep). Falls back to the raw path when
// it can't be resolved (a not-yet-existing path in a test, or a permission edge) — still deterministic per
// string, just not symlink-folded.
function realRepoPath(repoPath) {
  try { return realpathSync(String(repoPath)) } catch { return String(repoPath) }
}

// The solo org id for a repo: `<basename>-solo-<hash>`, capped to the 64-char project-name limit. Distinct
// from any team org by the RESERVED `-solo-<hash>` namespace (roster.js assertSafeProjectName rejects it +
// sanitizeProjectName strips it, so no team org can wear it); per-repo-unique by the hash of the RESOLVED
// path; deterministic (no RNG).
export function soloOrgId(repoPath) {
  const real = realRepoPath(repoPath)
  const base = sanitizeProjectName(basename(real)) || 'repo'
  const suffix = `-solo-${createHash('md5').update(real).digest('hex').slice(0, 8)}`
  return `${base.slice(0, 64 - suffix.length)}${suffix}`
}

export function soloRoomId(org) { return `${slug(org)}--solo` }

export function isSoloHandle(handle) { return String(handle || '').toLowerCase() === SOLO_HANDLE }

// The minimal persona for a solo member — a light charter (buildPersona emits the stripped `solo` protocol
// when it sees personaDef.solo, NOT the team-room block), so a plain session's behavior is unchanged until
// the human pulls a peer in.
function soloPersonaDef() {
  return {
    label: 'You',
    mandate: 'You are working solo. Do the work the human asks; reach them with @user (or ask_user) for '
      + 'decisions, approvals, or anything genuinely theirs. Otherwise proceed as a normal session.',
    mount: 'rw',
    tier: 'live',
    leadByDefault: false,
    custom: false,
    solo: true,
  }
}

// Build the single solo member with every field orgDef/defineOrg/memberLaunch/buildPersona consume —
// the same shape parseRoster's normMembers carry, so the whole downstream launch path is reused unchanged.
function soloMember(org) {
  return {
    id: `${slug(org)}:${SOLO_TEAM}:${SOLO_HANDLE.replace('/', '-')}`,
    first: SOLO_FIRST, backend: SOLO_BACKEND, handle: SOLO_HANDLE,
    role: SOLO_ROLE, roleLabel: 'You',
    // lead:false — a singleton leads no one. It carried lead:true only to satisfy the team stub's
    // leadHandle; that's cosmetic (orgDef doesn't send `teams`, and the solo room has no leads routing).
    // Leaving it true would arm a contradiction for any future code that keys on `member.lead` without
    // also checking `.solo` (a status view / routing heuristic inheriting "the solo human is a lead").
    team: SOLO_TEAM, lead: false, tier: 'live', territory: '.', mount: 'rw',
    personaDef: soloPersonaDef(),
  }
}

// Derive the normalized solo org for a repo. Same shape parseRoster returns: { org, repo, members, teams,
// rooms, customPersonas }. One live member, one `kind:'solo'` room seating the member + @user directly.
export function soloRoster(repoPath) {
  const repo = String(repoPath)
  const org = soloOrgId(repo)
  const member = soloMember(org)
  const rooms = [{ roomId: soloRoomId(org), kind: 'solo', team: SOLO_TEAM, members: [SOLO_HANDLE, '@user'] }]
  const teams = [{ name: SOLO_TEAM, territory: '.', leadHandle: SOLO_HANDLE, leadHandles: [SOLO_HANDLE], members: [SOLO_HANDLE] }]
  return { org, repo, members: [member], teams, rooms, customPersonas: {} }
}
