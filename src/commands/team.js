// `mrc team` — assemble and launch a team of agent members from a roster (team.json).
//
//   mrc team up      [path] [--roster f]   load roster, push it to the daemon, launch live members
//   mrc team status  [path]                show the org, rooms, and @user inbox
//   mrc team console <handle> [path]       attach to a running member's terminal (dtach)
//   mrc team down    [path]                stop the org's members (kill ttyd + container) + close rooms
//   mrc team define  [path]                push the roster to the daemon WITHOUT launching
//
// Live (Claude) members each run as their own `mrc <repo> --member <handle>` session inside a persistent
// `dtach` master (the session survives a console switch / dashboard close) with a per-member `ttyd`
// viewer for the browser terminal. Worker (non-Claude) members are declared in the org but invoked on
// demand (P5), so `up` does not spawn a container for them.
import net from 'node:net'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { memberSessionId } from '../teams/session-id.js'
import { atomicWriteFileSync } from '../rooms.js'
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'   // guard-4: hash an over-long ttyd socket leaf so it fits sun_path (never TCP-falls-back)
import { homedir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRoster, validateRoster, findRoster, RESERVED_SOLO_ORG_RE, assertSafeProjectName, sanitizeProjectName } from '../teams/roster.js'
import { addAuthorizedRepo, removeAuthorizedRepo, loadAuthorizedRepos } from '../teams/repo-auth.js'   // #49 multi-repo: the human control-plane over the per-org authorized-repo set (never a session verb)
import { memberCageLaunchGate } from '../teams/cage.js'   // #49 (4b Pierre item #5 twin): fail-closed worker-exec cage gate
import { soloRoster, SOLO_HANDLE } from '../teams/solo.js'
import { canonicalMountSource, canonicalWriteTarget } from '../mount-guard.js'   // #49: realpath-canonical mount/write containment (no symlink escape)
import { buildPersona } from '../teams/personas.js'
import { makeHandle } from '../teams/names.js'
import { PRESETS, listPresets, buildPreset } from '../teams/presets.js'
import { runWorkerExec, volumeName, imageIdAndLabels } from '../docker.js'
import { decideModelB } from '../mrc-store.js'   // Model B: the HIGHER capability gate (cap=2), separate from #5's store-mode (cap∈{1,2}) — so Model B stays inert on a cap=1 (#5-only) image until a deliberate rebuild
import { loadEnv, memberRepoEnvKey } from '../config.js'   // #49 cross-repo (Pierre Q4): member-secret MINT (caged member → no repo .env)
import { findFreePort } from '../ports.js'
import { loadLaunches, saveLaunch, setMemberLaunch, removeMemberLaunch, removeLaunch, controlSecret } from '../rooms.js'

const MRC_JS = fileURLToPath(new URL('../../mrc.js', import.meta.url))
const daemonMetaPath = () => join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json')
const readMeta = () => { try { return JSON.parse(readFileSync(daemonMetaPath(), 'utf8')) } catch { return null } }

// --- pure helpers (unit-tested) -------------------------------------------

// A stable, per-member conversation id (v5-style UUID from org+handle), so each member always
// targets its OWN conversation even though all members share /workspace/.mrc. Without this, a
// member's `--continue` would grab whichever member last wrote a transcript.
export { memberSessionId }   // shared impl: src/teams/session-id.js (no raw-NUL footgun)

// Docker volume flags for a member's view of the repo. A whole-repo writer gets rw /workspace; any
// other member gets /workspace READ-ONLY, with .mrc kept rw (session transcripts + persona file)
// and, for a sub-tree writer, just its territory mounted rw on top. This is the territorial write
// isolation: members literally cannot write outside their lane.
// #49 (realpath floor, Pierre-reviewed): the mount SOURCE (left of the colon = the host path) is
// realpath-canonicalized so a symlink in the repo can't escape (`territory:'evil'` where `evil -> /etc`);
// the container TARGET (right of the colon) STAYS the declared spelling, or the member sees its files at the
// wrong in-container path and territorial isolation breaks (Pierre trap #3). `.mrc` uses the may-not-exist
// canonicalizer (docker/setup may create it — catches a symlink `.mrc`, tolerates absence); the workspace root
// and the territory use canonicalMountSource (must exist — a missing territory throws, caught legibly at
// roster-validate, Pierre trap #2).
export function memberWorkspaceVolumes(member, repoPath) {
  // #49 multi-repo (Mouth B): mount the member's OWN repo. member.repo is the authorized, realpath-canonical
  // value the mint gate stamped (resolveMemberRepo, roster.js:251); it DEFAULTS to repoPath, so an own-repo
  // member is byte-identical to today. A cross-repo member mounts its authorized foreign repo — never the team
  // home. Falling back to repoPath keeps a member-less caller (tests) working.
  const root = member.repo || repoPath
  const vols = []
  if (member.cage) {
    // #49 (4b Phase-2): a CAGED member gets a fully READ-ONLY workspace — NO rw .mrc overlay (its transcript lives
    // in the isolated login vol via container-setup's ADVERSARY branch, keyed on MRC_ADVERSARY) and NO territory.
    // Both cage tiers declare workspace:'ro', so this is profile-correct today; a future rw-workspace tier would
    // route through applyCage's workspace dial instead. This is what keeps a caged cross-repo member from writing
    // ANYTHING into the foreign authorized repo.
    vols.push('-v', `${canonicalMountSource(root, '.')}:/workspace:ro`)
  } else if (member.mount === 'rw' && member.territory === '.') {
    vols.push('-v', `${canonicalMountSource(root, '.')}:/workspace`)
  } else {
    vols.push('-v', `${canonicalMountSource(root, '.')}:/workspace:ro`)
    vols.push('-v', `${canonicalWriteTarget(root, '.mrc')}:/workspace/.mrc`)
    if (member.mount === 'rw' && member.territory !== '.') {
      vols.push('-v', `${canonicalMountSource(root, member.territory)}:/workspace/${member.territory}`)
    }
  }
  return vols
}

// #49 multi-repo (Mouth B): the member's dedicated ~/.claude config-volume name — the ONE place the key is
// computed, so the live-member path (mrc.js) and the worker path (execWorker) can NEVER drift apart. Keying:
//   • own-repo member (crossRepo false): `${repoPath}#${handle}` — BYTE-IDENTICAL to today, zero re-login. A
//     team's home repo is already a faithful per-org proxy (two orgs have different home repos → distinct keys).
//   • cross-repo member (lives in a SHARED foreign repo): `${org}#${repo}#${handle}` — the repo alone is NOT an
//     org-proxy once repos are shared, so two orgs that both authorize /srv/shared and each draw the same handle
//     (`apolline/claude` from the shared name pool) would collide on `${repo}#${handle}` and SHARE one ~/.claude
//     = a cross-org OAuth/credential leak. Folding the org in makes the key injective across orgs (the same
//     isolation repo-auth.js keys per-org). `crossRepo` is authoritative-from-blob (memberArgv stamps it in the
//     OUTER where the team repo is known; the inner can't recompute it — argv[1] IS member.repo). A member-set
//     roster can't forge a collision: to share a repo it must be AUTHORIZED, and an authorized foreign repo is
//     crossRepo=true → org-scoped regardless of the flag.
// (KNOWN pre-existing edge, deliberately NOT fixed here: two team.jsons in ONE own-repo dir, both crossRepo=false,
//  same handle → same key. It predates this epic and fixing it would force universal re-login; documented, separate.)
export function memberConfigVolName(member, repoPath, org, modelB = false) {
  // Model B (Inc 2) — modelB gate (decideModelB, cap=2 — the HIGHER Model B capability, NOT #5's store-mode cap∈{1,2},
  // so this stays legacy on a #5-only image; threaded from the authoritative inspect, never a second read): key
  // UNIFORMLY on `${org}#${handle}`, no repo component.
  // Identity is the project+member, not the repo, so a member's ~/.claude login persists across repo changes and NO
  // repo is privileged (the own-repo `repoPath#handle` special-case retires here — its role is subsumed by org#handle,
  // just as the own-repo GRANT retires in resolveMemberRepo). Handles are unique within an org → org#handle is
  // injective; the cross-repo `#repo#` disambiguator is redundant once the key never carries a repo.
  if (modelB) return volumeName(`${org}#${member.handle}`, 1)
  // LEGACY (image not Model-B-capable — cap≠2 → modelB false, incl. a #5-only cap=1 image): byte-identical to today.
  // An un-passed modelB defaults false, so any caller not yet threading it stays on the legacy key.
  const crossRepo = member.crossRepo != null ? !!member.crossRepo : !!(member.repo && String(member.repo) !== String(repoPath))
  const key = crossRepo ? `${org}#${member.repo || repoPath}#${member.handle}` : `${repoPath}#${member.handle}`
  return volumeName(key, 1)
}

// Container env that marks this session as a team member + points at its persona file.
export function memberEnv(member, personaContainerPath) {
  const env = ['-e', `MRC_MEMBER_HANDLE=${member.handle}`, '-e', `MRC_TEAM=${member.team}`, '-e', `MRC_ROLE=${member.role}`]
  if (personaContainerPath) env.push('-e', `MRC_PERSONA_FILE=${personaContainerPath}`)
  return env
}

// The --append-system-prompt persona text for a member, built from its team's roster.
export function personaForMember(norm, member) {
  const roster = norm.members.filter((m) => m.team === member.team)
    .map((m) => ({ first: m.first, handle: m.handle, roleLabel: m.roleLabel, lead: m.lead }))
  const self = { first: member.first, handle: member.handle, roleLabel: member.roleLabel }
  return buildPersona({ self, team: member.team, roster, isLead: member.lead, territory: member.territory, mount: member.mount, role: member.role, personaDef: member.personaDef })
}

const personaSlug = (handle) => handle.replace(/[^a-z0-9]+/gi, '-')

// Write a member's persona to <repo>/.mrc/teams/<handle>.persona (host) and return the in-container
// path (/workspace/.mrc/... ). Read in the entrypoint via --append-system-prompt "$(cat …)" — safe
// against backticks/$ in the prompt (command-substituted text is not re-scanned).
export function writePersonaFile(repoPath, member, text) {
  const name = `${personaSlug(member.handle)}.persona`
  // #49 (Pierre trap #4): the write is TWO syscalls (mkdir + write) and BOTH must build from the guard's
  // RETURN — a mkdir on the raw `join(repo,'.mrc','teams')` FOLLOWS a `.mrc -> /etc` symlink and creates
  // /etc/teams before the write ever runs. So canonicalize the write target, then mkdir its DIRNAME and write
  // THE RETURN — never the raw spelling.
  const p = canonicalWriteTarget(repoPath, join('.mrc', 'teams', name))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return `/workspace/.mrc/teams/${name}`   // in-container path (declared) — unchanged
}

// The full org definition pushed to the daemon (what the engine.defineOrg expects).
export function orgDef(norm) {
  return { org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms }
}

// The container's stdout wraps the worker's reply in sentinels (printed by entrypoint.sh) so the
// firewall/setup chatter is stripped. Falls back to the trimmed tail if the markers are missing.
export function cleanWorkerOutput(out) {
  const s = String(out)
  const m = s.match(/===MRC-WORKER-OUTPUT-START===\n?([\s\S]*?)\n?===MRC-WORKER-OUTPUT-END===/)
  return (m ? m[1] : s).trim() || '(the worker produced no output)'
}

// Run one worker turn in a sandboxed container scoped to the member's territory; return its reply.
// Memory substrate: a stable per-member codex/claude config volume persists the backend's own state
// across turns. (This is the one path that needs Docker — validated via the rebuild recipe.)
export async function execWorker(norm, member, repoPath, prompt) {
  // #49 (4b Pierre item #5 TWIN): FAIL-CLOSED, symmetric with mrc.js's live-member gate. The worker-exec path
  // never applies the cage (no applyCage here; it sets ALLOW_WEB=1 below), so a caged worker must REFUSE, not
  // launch silently uncaged with full egress. Latent today (assertCageAllowed rejects pinned+non-claude, contained
  // un-mintable → no cage is both worker-parse-acceptable AND mintable), but this makes "a caged member/worker
  // refuses until its launch path enforces the cage" a TWO-path invariant, so a future worker-compatible tier
  // can't ship uncaged on this twin. Graceful { ok:false } (the daemon's worker invoker records ✕, doesn't crash).
  { const g = memberCageLaunchGate(member); if (!g.ok) return { text: `(refused: ${g.reason})`, ok: false } }
  loadEnv(dirname(MRC_JS))   // populate OPENAI_API_KEY etc. (team dispatch runs before mrc.js loads .env)
  // #49 multi-repo (Mouth B): the worker path has NO inner-launch seam (it's a direct docker exec in the OUTER),
  // so member.repo is threaded EXPLICITLY at every file/secret site. The daemon launches `_worker-exec --repo
  // member.repo`, so repoPath IS member.repo here → for an own-repo member `root` === repoPath → BYTE-IDENTICAL.
  // The config-vol keys through the ONE shared helper, and — CRUCIAL — crossRepo rides the member from the MINT
  // (roster.js) through room-daemon's worker blob to here, so `member.crossRepo` is authoritative EVEN THOUGH
  // repoPath===member.repo collapses the repo-compare: a cross-repo worker is org-scoped, closing the cross-org
  // config-vol collision on the worker tier too (not just the live path). What STAYS deferred for the worker is
  // the CAGE/egress axis only — ALLOW_WEB=1 + untrusted foreign prompt = the worker-cage epic — NOT isolation.
  const root = member.repo || repoPath
  const org = member.org || norm?.org
  const name = `${personaSlug(member.handle)}.exec-prompt`
  // #49 (Pierre trap #4): canonicalize the write target; mkdir its DIRNAME + write THE RETURN (both from the
  // guard — a raw-join mkdir would follow a symlinked `.mrc`).
  const promptPath = canonicalWriteTarget(root, join('.mrc', 'teams', name))
  mkdirSync(dirname(promptPath), { recursive: true })
  writeFileSync(promptPath, prompt)
  const containerPromptFile = `/workspace/.mrc/teams/${name}`
  const vols = [...memberWorkspaceVolumes(member, root)]
  // Model B (Inc 2): decide modelB from the SAME image + the SAME decision function the live path uses
  // (mister-claude's `mrc.store.capability` label → decideModelB, cap=2), so the worker key and the live key agree by
  // construction — same image ⇒ same modelB ⇒ same `${org}#${handle}` (or the same legacy key when cap≠2, incl. a
  // #5-only cap=1 image). imageIdAndLabels fails toward legacy ({}), so a docker hiccup degrades to the legacy key,
  // never a false Model-B key. (A rebuild BETWEEN a live launch and a worker turn could differ → a one-time worker re-login;
  // benign + greenfield, and the worker's config vol is its own backend state, not the user's login.)
  const modelB = decideModelB(imageIdAndLabels().labels)
  const volName = memberConfigVolName(member, repoPath, org, modelB)   // ONE keying helper — no drift vs the live path
  vols.push('-v', `${volName}:/home/coder/.claude`, '-v', `${volName.replace('mrc-config-', 'mrc-codex-')}:/home/coder/.codex`)
  const env = [
    '-e', `MRC_AGENT=${member.backend}`, '-e', `MRC_MEMBER_HANDLE=${member.handle}`,
    '-e', `MRC_TEAM=${member.team}`, '-e', `MRC_ROLE=${member.role}`,
    '-e', `MRC_EXEC_PROMPT_FILE=${containerPromptFile}`, '-e', 'ALLOW_WEB=1',
  ]
  const openai = memberRepoEnvKey(member, 'OPENAI_API_KEY')   // the AUTHORIZED repo's .env first, then global; a caged member is denied (chokepoint)
  if (openai) env.push('-e', `OPENAI_API_KEY=${openai}`)
  const r = runWorkerExec({ repoPath: root, envFlags: env, volumes: vols, allowWeb: true })   // #48: { text, ok }
  return { text: cleanWorkerOutput(r.text), ok: r.ok }
}

function readStdin() {
  return new Promise((res) => {
    if (process.stdin.isTTY) return res('')
    let d = ''; process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => { d += c }); process.stdin.on('end', () => res(d))
  })
}

// --- daemon control --------------------------------------------------------
function controlCall(controlPort, frame, timeoutMs = 2000) {
  return new Promise((res) => {
    const c = net.connect(controlPort, '127.0.0.1', () => c.write(JSON.stringify(frame) + '\n'))
    let buf = ''
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { res(JSON.parse(buf.slice(0, i))) } catch { res(null) } c.end() } })
    c.on('error', () => res(null))
    setTimeout(() => { try { c.destroy() } catch {}; res(null) }, timeoutMs)
  })
}

// Ensure the daemon is up and push the org definition to it. Returns { ok, controlPort, rooms }.
export async function pushOrg(norm) {
  const { ensureRoomDaemon } = await import('./pair.js')
  const portBase = Number(process.env.MRC_PORT_BASE) || 7722
  const daemon = await ensureRoomDaemon({ relayPort: portBase, notifyPort: 0 })   // #50: ensureRoomDaemon takes relayPort (the fixed constant), not portBase
  // guard-1: CLI `team up`/`define` is a human terminal act → it MAY first-pin the argv the human typed AND activate.
  // Prove the capability with the host-only secret (read the 0600 file — same-uid; a cross-uid process can't) so a
  // raw wire frame can't assert trusted/activate. The daemon (up first via ensureRoomDaemon) has minted it.
  const r = await controlCall(daemon.controlPort, { action: 'defineOrg', def: orgDef(norm), trusted: true, activate: true, secret: controlSecret() })
  return { ok: !!r?.ok, controlPort: daemon.controlPort, daemonPort: daemon.port, rooms: r?.rooms || [], error: r?.error }
}

// --- launching -------------------------------------------------------------
function loadRoster(repoPath, rosterPath) {
  const path = rosterPath || findRoster(repoPath)
  if (!path) throw new Error(`no roster found. Create team.json in ${repoPath} (or pass --roster <file>).`)
  // Model B: parse in the SAME mode the launch runs in. A daemon-spawned `mrc team up` inherits the daemon's ONE
  // decision via MRC_MODEL_B_PREDICT; a human CLI `mrc team up` (no daemon env) self-inspects the exact image
  // (decideModelB). So a legacy-shaped team.json (no per-member repos) on a cap=2 image FAILS CLOSED (parseRoster
  // modelB requires explicit authorized member repos) rather than a mixed legacy/Model-B launch. Inert at cap≠2.
  const modelB = process.env.MRC_MODEL_B_PREDICT != null
    ? process.env.MRC_MODEL_B_PREDICT === '1'
    : decideModelB(imageIdAndLabels().labels)
  const norm = parseRoster(readFileSync(path, 'utf8'), { repo: repoPath, modelB })
  return { norm, path }
}

// #5 PICKABLE⟺MIGRATED: the set of memberSessionId transcript uuids for a repo's team roster. A plain picker
// AND the plain-slice migration must EXCLUDE these identically — they're @member private transcripts (in the
// SHARED repo/.mrc, named by memberSessionId, UUID-shaped so filename-indistinguishable from a plain conversation
// UUID), NOT the user's own plain sessions. Derived ONCE from team.json; the same set feeds the picker filter and
// the migration copy-set so (pickable − migrated) is empty by construction (no ghost pick, no member bleed into
// the plain slice). It's also correct independent of store-mode: a plain `mrc pick` shouldn't list @alice's
// conversation (manager.js already blinds the picker to ADVERSARY sessions; members are the gap — they're in .mrc).
// No roster → empty set → nothing excluded (all sessions ARE plain, correct). Unreadable roster → empty (fail
// toward list/migrate-as-plain — a member ghost is a host-side confusion of the user's OWN repo, never a
// cross-identity leak; the daemon-bind is the real member boundary).
export function rosterMemberSessionIds(repoPath) {
  const out = new Set()
  try {
    const path = findRoster(repoPath)
    if (!path) return out
    const norm = parseRoster(readFileSync(path, 'utf8'), { repo: repoPath })
    for (const m of norm.members) out.add(memberSessionId(norm.org, m.handle))
  } catch {}
  return out
}

// #49: PURE, Docker-free selection of which roster a member-mode launch binds — extracted from mrc.js so
// the coercion-resistance GUARANTEE (a --solo launch picks soloRoster and NEVER reads a repo team.json) is
// asserted by a test, not left as a one-branch-deep inline guard a future refactor could silently reorder
// (Pierre: the lead:true fuse, one file over). `loadRoster` is injected so a test can assert it is never
// called on the solo path. Returns { norm, handle, rosterPath }. Invariants: solo ⇒ soloRoster + handle
// FORCED to SOLO_HANDLE (an injected `--member` can never redirect a solo launch, and team.json is never
// even read); non-solo ⇒ loadRoster(team.json) with the requested handle.
export function resolveMemberNorm(config, repoPath, { loadRoster: load = loadRoster } = {}) {
  if (config.solo) {
    return { norm: soloRoster(repoPath), handle: SOLO_HANDLE, rosterPath: null }
  }
  const { norm, path: rosterPath } = load(repoPath, config.roster)
  return { norm, handle: String(config.member || '').toLowerCase(), rosterPath }
}

// #49-SEC (member-writable-roster confused deputy): resolve the AUTHORITATIVE member for a launch — the
// identity/mount/territory/repo/cage the container gets. PURE + TESTED (like resolveMemberNorm), so the
// "no roster backstop of a security field" invariant is a TEST ASSERTION, not a trust-the-branch-order. Two
// authoritative sources, and NO security field is ever read from the member-writable roster (team.runtime.json
// in the rw-mounted .mrc):
//   • solo → the soloRoster member with its repo-DERIVED org stamped (norm here IS soloRoster — derived from
//            repoPath, a launch arg, not a mounted file — so it's authoritative by construction).
//   • team → the OUTER launcher's host-set --member-def blob (base64 json), REQUIRED, JSON-validated, with its
//            required boundary fields present and its handle matching the requested --member.
// THROWS (fail-closed) on a missing / malformed / field-short / handle-mismatched blob — it NEVER falls back to
// `norm` (the member-writable roster). A caller catches and refuses the launch. There is deliberately NO
// `?? norm.<field>` anywhere: a roster-parsed value backstopping a missing authoritative one is the exact
// regression that reopens the org/mount/cage doors.
export function resolveMemberIdentity(config, norm, handle) {
  if (config.solo) {
    const sm = norm.members.find((m) => m.handle === handle || m.first.toLowerCase() === handle)
    return sm ? { ...sm, org: norm.org } : null
  }
  if (!config.memberDef) throw new Error('a team-member session requires the launcher-set --member-def (run `mrc team up`, not a bare `--member`)')
  let auth
  try { auth = JSON.parse(Buffer.from(String(config.memberDef), 'base64').toString('utf8')) }
  catch (e) { throw new Error(`unreadable --member-def (${e?.message || e})`) }
  if (!auth || typeof auth !== 'object' || !auth.handle || !auth.org || !auth.mount || !auth.territory) {
    throw new Error('--member-def is missing a required authoritative field (org/handle/mount/territory)')
  }
  if (String(auth.handle).toLowerCase() !== String(handle)) throw new Error(`--member-def is for @${auth.handle}, not the requested @${handle}`)
  return auth   // authoritative WHOLESALE — org/mount/territory/repo/cage all from the host-set blob, not the roster
}

// #49-SEC (member-writable-roster confused deputy): pass the OUTER launcher's ALREADY-RESOLVED, already-authorized
// member def (+ its authoritative team org) to the inner `mrc --member` as a host-set argv the member CONTAINER
// cannot tamper (it's baked into the dtach master's shell command, a host process). The inner derives EVERY
// security-load-bearing field from THIS blob — org→sessionId, mount/territory→write-scope, repo, cage — NEVER from
// the member-writable roster (team.runtime.json lives in the rw-mounted .mrc). --roster survives only as display
// context (persona teammates). base64 so a persona mandate with quotes/newlines can't break shell quoting. `org`
// is the AUTHORITATIVE team org (norm.org at team-up / def.org on relaunch) — the label the daemon keyed its
// sessionIndex on — so the inner computes the SAME sessionId and binds to the right org even if the on-disk roster
// was re-tampered in the relaunch TOCTOU window.
// #49 multi-repo (Mouth B): the inner launches in member.repo (the authorized, realpath-canonical value the mint
// gate stamped) — the SINGLE seam that makes a cross-repo member coherent by construction. Inside the inner,
// repoPath === member.repo, so every repoPath-derived FILE door (workspace mount, .mrc, sandboxignore, legacyDir,
// the store slice) resolves to the member's own repo automatically; identity stays the TEAM org (this blob's
// `org`, never basename(member.repo)). `crossRepo` is stamped AT THE MINT (roster.js) and rides the member here;
// we PREFER that authoritative value and only compute it as a legacy belt for a mint-less member (tests) — so the
// inner keys its config-vol org-scoped without re-deriving it (it can't: argv[1] is member.repo, the team home
// isn't visible downstream). The mint is the single source; this belt agrees with it (same formula).
export function memberArgv(repoPath, member, rosterPath, org, { web = false } = {}) {
  const crossRepo = member.crossRepo != null ? !!member.crossRepo : !!(member.repo && String(member.repo) !== String(repoPath))
  const def = Buffer.from(JSON.stringify({ ...member, org, crossRepo }), 'utf8').toString('base64')
  // #57 per-project --web: thread the org's egress setting into the member's OWN launch → the inner mrc.js sets
  // ALLOW_WEB=1 → init-firewall.sh opens 443. NEVER for a caged member (belt 3): mrc.js forces allowWeb=false for
  // a cagedAdversary and init-firewall.sh drops 443 for MRC_ADVERSARY_FW — this !member.cage gate is the outermost
  // of the three, so a web-enabled team can never hand egress to its contained adversary.
  const webFlag = (web && !member.cage) ? ['--web'] : []
  return [MRC_JS, member.repo || repoPath, '--member', member.handle, '--roster', rosterPath, '--member-def', def, ...webFlag]
}

// Is a recorded process still alive? (signal 0 = existence check; EPERM still means it exists.)
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
// A member session is servable only if its socket file exists AND a live dtach MASTER holds it — both
// derived from the deterministic sock path, NEVER the stored dtachPid (#41 Gate-1: a recycled stale pid
// would otherwise read "alive" and mis-classify a dead member as up, the same hazard de-pid'd in teardown).
const sessionAlive = (info) => !!(info && info.sock && existsSync(info.sock) && masterAliveForSock(info.sock))
// pgrep -f for processes whose cmdline holds `<flag> <exact sock>` as a whole token. The sock path is
// regex-ESCAPED and bounded by a trailing space-or-end so a sibling whose slug is a prefix (handle `a` vs
// `ab`) can't substring-collide, and the flag (`-n` master vs `-a` viewer) keeps the two roles distinct.
// Anchoring on the deterministic sock PATH (not a persisted pid) is drift-proof AND pid-reuse-safe — we
// never signal a recycled pid that now belongs to an unrelated host process.
let _pgrepMissingWarned = false
function pidsForSock(flag, sock) {
  const esc = String(sock).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try { return execFileSync('pgrep', ['-f', `dtach ${flag} ${esc}( |$)`], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean) }
  catch (e) {
    // pgrep exit 1 = ran, NO match → legit empty. ENOENT = pgrep MISSING → liveness AND teardown silently
    // no-op forever (every terminal reads orphaned; Relaunch reaps nothing → unbreakable loop). Do NOT
    // conflate the two (#41 / no-silent-failure): surface the missing binary LOUDLY, once. The launch-time
    // hasPgrep() guards `team up`; this guards the continuous DAEMON detection/Relaunch path (Roland).
    if (e?.code === 'ENOENT' && !_pgrepMissingWarned) {
      _pgrepMissingWarned = true
      try { console.error('[#41] FATAL: `pgrep` not found — member-terminal liveness/teardown cannot work (every terminal reads orphaned; Relaunch no-ops). Install procps (apt install procps; standard on macOS + Linux).') } catch {}
    }
    return []
  }
}
// Is a LIVE dtach MASTER (`dtach -n <sock>`) holding this socket? True even when the launch record drifted
// (b′). The ttyd viewer is `dtach -a`, so it never matches. Gates the spawn unlink + the orphaned read.
function masterAliveForSock(sock) { return pidsForSock('-n', sock).length > 0 }
// Reap a member's host plumbing by the deterministic sock path: the dtach MASTER (`-n`) and its ttyd
// VIEWER (`-a`), matched exactly (never a stored pid → drift-proof + pid-reuse-safe + no sibling/viewer
// over-kill). Does NOT touch the socket file or the container — the caller handles those.
function killHostPlumbingForSock(sock) {
  const pids = [...pidsForSock('-n', sock), ...pidsForSock('-a', sock)].map(Number)
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch {} }
  // Escalate like the daemon-restart kill: a master parked at `; read` should die on SIGTERM, but SIGKILL
  // any survivor a beat later so a wedged process can't outlive teardown (else the leaked-master residue
  // we're eliminating persists). unref so a short-lived CLI (`mrc team down`) isn't held open by it.
  if (pids.length) { const t = setTimeout(() => { for (const pid of pids) { try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch {} } }, 600); t.unref?.() }
  return pids.length > 0
}
// Stop the actual member: kill its container by the mrc.member (+project) label. Killing the dtach master
// tears down the terminal/sh but the detached `docker run` container can keep running — so this is the
// LOAD-BEARING member stop, not a backstop (Roland #1).
function dockerKillMember(org, handle) {
  // Require BOTH labels. Handles are deterministic (first/backend), so two ORGS can share one (each with an
  // @apolline/claude); matching mrc.member=<handle> alone — if the org were unknown — would kill the OTHER
  // org's same-handled container. Fail SAFE: skip + log rather than an org-wide kill-by-handle. #49 multi-repo
  // (Mouth B): disambiguate on mrc.project=<ORG> — the AUTHORITATIVE identity (set from the --member-def blob,
  // mrc.js:1077, not the member-writable roster) — NOT mrc.repo. mrc.repo was only ever a per-org PROXY; a
  // cross-repo member's container is labelled mrc.repo=member.repo, so a mrc.repo filter can't find it, while
  // mrc.project IS the org and matches it. This is strictly more correct AND dissolves the same-handle hazard.
  if (!org) { try { console.error(`[#34] dockerKillMember: no org for @${handle} — skipping (won't risk a cross-org kill-by-handle)`) } catch {}; return }
  try {
    const ids = execFileSync('docker', ['ps', '-q', ...memberDockerFilter(org, handle)], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean)
    for (const id of ids) { try { execFileSync('docker', ['kill', id], { stdio: 'ignore' }) } catch {} }
  } catch {}
}
// #49 multi-repo (Mouth B): the `docker ps` filter selecting an org's member container(s) — the ONE place the
// disambiguator is chosen, exported so a test asserts it's mrc.project=<RAW org> (identity) never mrc.repo (a
// per-org proxy that a cross-repo member's mrc.repo=member.repo would fail to match). handle present → one
// member; absent → any member of the org (the #41 live-set probe). Raw org on both sides (no slug), matching
// the authoritative mrc.project label (mrc.js:1077).
export function memberDockerFilter(org, handle) {
  return ['--filter', handle ? `label=mrc.member=${handle}` : 'label=mrc.member', '--filter', `label=mrc.project=${org}`]
}
// #41 detection: the set of member handles whose mrc.member CONTAINER is live — the durable, master-state-
// independent "member up" signal (a container can outlive its master). One `docker ps` per org per poll.
// #49 multi-repo: keyed on mrc.project=<ORG> (not mrc.repo) so two orgs sharing a handle don't cross-count AND
// a cross-repo member (mrc.repo=member.repo) is still detected (same fix + fail-safe as the kill).
let _dockerProbeWarned = false
function dockerMemberHandles(org) {
  if (!org) return new Set()
  try {
    // `docker ps --format` exposes a label via the `.Label "k"` METHOD; `.Labels` here is a comma-joined
    // STRING (NOT the map it is under `docker inspect`), so `index .Labels "k"` throws "cannot index
    // slice/array with type string" → non-zero exit → (pre-fix) a silently-empty Set → every container
    // reads absent → all terminals blank. Use the ps-correct `.Label` (matches room-daemon.js's scan).
    const out = execFileSync('docker', ['ps', ...memberDockerFilter(org), '--format', '{{.Label "mrc.member"}}'], { encoding: 'utf8' })
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))
  } catch (e) {
    // No-silent-failure: a broken probe (bad template, docker unreachable) must NOT masquerade as "zero
    // containers" — that's exactly what blanked every terminal for hours. Surface it LOUDLY, once. The
    // serve classification no longer DEPENDS on this (it falls back to live host plumbing), but a failing
    // probe still degrades orphaned-vs-starting accuracy, so it must be visible, not swallowed.
    if (!_dockerProbeWarned) { _dockerProbeWarned = true; try { console.error(`[#41] docker member-probe failed (terminals fall back to host-plumbing liveness): ${(e?.stderr || e?.message || e).toString().trim().split('\n')[0]}`) } catch {} }
    return new Set()
  }
}
// #56 Inc1 (Pierre-signed liveness gate): is a SPECIFIC member's container running RIGHT NOW? Matches the
// MOST-SPECIFIC label pair (mrc.member=<handle> + mrc.project=<org>) so a consult restore never false-matches a
// DIFFERENT Pierre's routing onto this handle. Docker-unreachable → false, but the CALLER must treat a miss as
// SKIP-the-restore (never delete the store entry): a host reboot where docker hasn't re-started the container yet
// reads as "dead," and a false-delete would drop a Pierre that's about to come back. Only explicit dismiss +
// confirmed orphan-reap delete; the stale-GC ages out the truly-dead.
export function memberContainerAlive(org, handle) {
  if (!org || !handle) return false
  try { return execFileSync('docker', ['ps', '-q', ...memberDockerFilter(org, handle)], { encoding: 'utf8' }).trim().length > 0 }
  catch { return false }
}
// Is a live ttyd VIEWER (`dtach -a <sock>`) serving this member's terminal? (distinct from the master).
// LOAD-BEARING INVARIANT: this MUST match the ttyd PROCESS's own cmdline (durable from spawn — ttyd runs
// `dtach -a <sock>` eagerly, before any browser attaches), NEVER gate on a live browser connection. If a
// future edit makes this connection-gated, every online-but-unviewed member reads orphaned → mass
// false-orphaned, and the in-suite tests (no real ttyd) would NOT catch it. (§9 + the spawn test guard it.)
// Residual (Roland): checks the process EXISTS, not that its port is accepting — a wedged-but-alive ttyd
// would read 'serve' → blank embed; ttyd is a tiny robust C server so a long-lived wedge is unlikely (add a
// port-listen probe only if a "serving" terminal is ever reported blank).
const ttydAlive = (info) => !!(info && info.sock && pidsForSock('-a', info.sock).length > 0)
// #41 per-member terminal STATE for the dashboard. FAIL-TOWARD-STARTING: "orphaned" must EARN its way on
// positive establishment evidence; anything inconclusive reads "starting" (a false-starting just shows the
// wait copy a beat longer + self-heals; a false-orphaned would dangle a Relaunch that bounces a slow member
// and kills a starting session). containerAlive/online/withinGrace are LIVE facts from the reconcile.
//   serve    = container alive + servable (master + socket + ttyd viewer all live)
//   orphaned = container alive + NOT servable + ESTABLISHED (online now [restart-durable] / (b)-fingerprint:
//              master-alive+socket-gone / past the build grace) → "Relaunch to restore"
//   building = NO container yet + within the build grace → image build / first run (minutes) → distinct
//              honest copy ("first run takes a few minutes"), so a 4-min build isn't mis-read as broken and
//              re-Launched (fail-toward-starting at the right granularity). Container-presence is the pure
//              detection boundary between a cold build (minutes) and a warm start (seconds).
//   starting = CONTAINER up but NOT servable + NOT established (within grace) → agent onlining, "a moment"
//   dead     = no live container, PAST grace → the genuine "not launched, Build + Launch" state
export function classifyTerminal(info, { containerAlive, online, withinGrace } = {}) {
  // VIEWABILITY FIRST. A terminal is serveable iff its host plumbing — the dtach master, its socket, and a
  // live ttyd viewer — is up; that is the literal precondition for the embedded iframe and is INDEPENDENT
  // of the docker probe. Checking it before the container gate means a failed/empty `docker ps` can never
  // blank a terminal that is in fact being served (the #41 hazard: a flaky probe stranded every live member
  // behind "isn't launched"). The container fact remains the anchor for the NON-serving cases below.
  if (sessionAlive(info) && ttydAlive(info)) return 'serve'
  if (!containerAlive) return withinGrace ? 'building' : 'dead'
  // (b)-fingerprint read from the COMMITTED record: a live master whose socket FILE vanished. A member
  // mid-spawn (no committed `sock` yet) is NOT a fingerprint → falls through to grace → starting.
  const bFingerprint = !!(info && info.sock && !existsSync(info.sock) && masterAliveForSock(info.sock))
  const established = !!online || bFingerprint || !withinGrace
  return established ? 'orphaned' : 'starting'
}

// Single-quote a value for a `sh -c` string, escaping embedded quotes (close-quote, escaped-quote,
// reopen: ' -> '\''). A member `name` in team.json is user-authored and only lowercased, so without this
// a crafted name (e.g. `'; rm -rf … #`) would break out of the quotes and run on the HOST at `mrc team up`
// — before any container isolation. (A cloned repo's malicious team.json is the real vector.)
const shq = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`
// The shell command ttyd runs for a member: the member session, then a persisted exit line so the browser
// terminal shows "[@x exited — press enter]" instead of ttyd dropping the session the instant Claude exits.
const memberShellCmd = (repoPath, m, rosterPath, org, { web = false } = {}) =>
  `node ${memberArgv(repoPath, m, rosterPath, org, { web }).map(shq).join(' ')}; echo; echo ${shq(`[@${m.first} exited — press enter]`)}; read`

// dtach sockets (one per member, stable across reconnects) live under the daemon dir.
const socketDir = () => join(homedir(), '.local', 'share', 'mrc', 'sockets')
const sockSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const memberSock = (org, handle) => join(socketDir(), `${sockSlug(org)}-${sockSlug(handle)}.dtach`)
// guard-4: ttyd LISTENS on this per-member UNIX SOCKET (not a TCP port) — a browser can't open a unix socket, so
// the Cross-Site WebSocket Hijack dies at the transport; the dashboard proxies /ttyd/<org>/<handle> to it same-origin.
// The `.sock` suffix is LOAD-BEARING: ttyd/libwebsockets enters unix-socket mode ONLY when `-i <path>` ends in
// `.sock` (a bare name → treated as a NETWORK INTERFACE → "iface DOESN'T EXIST" → NO socket → ttyd SILENTLY binds
// its default TCP 0.0.0.0:7681 = a network-reachable `-W` writable terminal, the exact CSWSH guard-4 kills → the
// dashboard proxy 404s → a forever-black terminal). This ttyd does NOT honor a `unix:` prefix, so the suffix is the
// only lever. The path LENGTH is equally load-bearing (Pierre): macOS caps a unix socket path (sun_path) at ~104
// bytes; if `<slug>-<slug>.ttyd.sock` would overflow, bind() fails → the SAME silent TCP-0.0.0.0 fallback, for long
// names only. So an over-long name is hashed to a short, stable, `.sock`-suffixed leaf that ALWAYS fits — we fail
// INTO a unix socket, never into TCP. Deterministic (sha1(org\0handle)) so every teardown re-derives the same path.
const SUN_PATH_MAX = 100   // conservative vs the macOS ~104-byte sun_path cap (leaves margin for the NUL terminator)
export const memberTtydSock = (org, handle) => {
  const dir = socketDir()
  const readable = join(dir, `${sockSlug(org)}-${sockSlug(handle)}.ttyd.sock`)
  if (Buffer.byteLength(readable) <= SUN_PATH_MAX) return readable
  const h = createHash('sha1').update(`${org}\0${handle}`).digest('hex').slice(0, 16)   // 28-char leaf, always fits
  return join(dir, `m-${h}.ttyd.sock`)
}

// #34: a member runs inside a persistent `dtach -n` MASTER (holds the session detached so it survives the
// browser disconnecting / a console switch / the dashboard closing — what tmux used to do), with a thin
// ttyd VIEWER (`dtach -a`) that attaches on connect and RE-ATTACHES the same session on reconnect (no
// restart). dtach is a transparent byte relay, so ttyd's real xterm-256color + the native mouse-wheel
// scroll pass straight through. Returns the registry entry.
function spawnMemberSession(org, handle, port, shellCmd) {
  const sock = memberSock(org, handle)
  mkdirSync(dirname(sock), { recursive: true })
  try { chmodSync(dirname(sock), 0o700) } catch {}   // guard-4: the socket dir is 0700 — the LOAD-BEARING perm (no other local user can traverse to a member's ttyd/dtach socket, whatever its own mode)
  // #41 unlink-guard (defense-in-depth, AT THE SOURCE — covers every caller incl. addMember): NEVER unlink
  // a socket whose dtach master is still alive. The old unconditional unlink, hit on a relaunch re-entry,
  // orphaned the live master — its container keeps running + reads "ready" but the terminal becomes forever
  // unreachable (dtach won't recreate the socket). A live master must be torn down via killMember FIRST.
  if (masterAliveForSock(sock)) throw new Error(`refusing to (re)spawn @${handle}: a live dtach master still owns ${basename(sock)} — stop it first (killMember) to avoid orphaning it`)
  try { unlinkSync(sock) } catch {}   // safe now: no live master holds this sock
  const env = { ...process.env, TERM: 'xterm-256color' }
  // persistent master: holds the member detached, eager-started (runs even before a browser attaches).
  const master = spawn('dtach', ['-n', sock, '-E', '-r', 'winch', 'sh', '-c', shellCmd], { detached: true, stdio: 'ignore', env })
  master.unref()
  // viewer: ttyd attaches to the dtach session; a reconnect re-attaches the SAME session. guard-4: ttyd listens on
  // a UNIX SOCKET (`-i <ttydSock>`) — NOT a TCP port (`-p` is GONE, so NO browser-reachable TCP listener survives);
  // the dashboard proxies it same-origin.
  const ttydSock = memberTtydSock(org, handle)
  try { unlinkSync(ttydSock) } catch {}   // safe: we hold this member's dtach master (checked above) → this ttyd sock is ours-stale
  const ttyd = spawn('ttyd', ['-W', '-i', ttydSock, 'dtach', '-a', sock, '-E', '-r', 'winch'], { detached: true, stdio: 'ignore', env })
  ttyd.unref()
  try { chmodSync(ttydSock, 0o600) } catch {}   // belt (best-effort; ttyd binds async so this may pre-empt — dir-0700 above is the real gate)
  return { sock, dtachPid: master.pid, ttydSock, ttydPid: ttyd.pid, containerId: null }
}

// guard-4 launch-time DURABILITY invariant (Pierre): ttyd is a HOST binary (brew/system), OUTSIDE mrc's control —
// a future `brew upgrade ttyd` could change `-i <path>` handling and silently reintroduce the TCP-0.0.0.0:7681
// fallback we caught on 1.7.7, INVISIBLE to the unit suite (the failure is host-version-dependent). A one-time
// wire-test proves today's ttyd, not tomorrow's. So VERIFY BY CONSTRUCTION at every launch: the `.ttyd.sock` MUST
// materialize shortly after spawn — its PRESENCE is proof ttyd entered unix-socket mode; a TCP-fallback ttyd creates
// NO socket, whatever the cause (unknown suffix, ENAMETOOLONG, bind failure). If it doesn't appear, KILL the ttyd
// (so nothing lingers on 0.0.0.0) and throw → the caller flags the member orphaned + logs loud. A black terminal +
// a real error ALWAYS beats a silent network-exposed writable terminal. (Deps injected for tests.)
// COMPLEMENT (Pierre): this is the always-on runtime catch for the OBSERVED failure (fall-back-with-no-socket). It
// does NOT prove "unix ONLY" — an improbable future dual-bind ttyd (socket AND 7681) would create the socket + pass
// here. `claude-scripts/ttyd-notcp.sh` (lsof) stays the UPGRADE-time belt for that edge; they prove different negatives.
export async function assertTtydUnixSocket(ttydPid, ttydSock, { timeoutMs = 3000, stepMs = 100, exists = existsSync, kill = process.kill, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (exists(ttydSock)) return true
    if (Date.now() >= deadline) break
    await sleep(stepMs)
  }
  if (ttydPid) { try { kill(ttydPid, 'SIGKILL') } catch {} }   // no unix socket → NOT unix mode → kill so no TCP listener lingers on 0.0.0.0
  const err = new Error(`ttyd did not create its unix socket ${basename(ttydSock)} within ${timeoutMs}ms — the host ttyd isn't binding a unix socket (needs ttyd >= 1.7 honoring '-i <path>.sock', or the socket path is too long). It may have fallen back to a TCP listener; killed it.`)
  err.code = 'TTYD_NO_UNIX_SOCKET'   // a DETERMINISTIC orphan — the caller distinguishes it from a transient one (Relaunch re-fails until the host ttyd is fixed)
  throw err
}

// #34: launch each live member as its own persistent dtach session + ttyd viewer. Reuses a member's
// existing session if its dtach master is still alive (idempotent relaunch). Returns the registry map.
async function launchMembers(norm, repoPath, rosterPath, live, { web = false } = {}) {
  // Site 5 (Model B) — the daemon-predict → OUTER-assert, the assertTtydUnixSocket shape applied to Model-B mode.
  // The daemon threaded its ONE prediction as MRC_MODEL_B_PREDICT; this process reads the AUTHORITATIVE actual from
  // the exact image it's about to launch (decideModelB). Assert they AGREE **before spawning any dtach master** —
  // a mismatch (a rebuild landed between the daemon's define/predict and this launch) → THROW at the launch boundary
  // → the daemon's detached child exits non-zero → failLaunch flips launching→failed CLEAN. Critically the throw
  // PRECEDES the dtach spawn, so there is NO orphaned-ALIVE master (a self-killed inner inside a live master whose
  // shell `read`s would keep reading as "up" and never self-correct). Only asserts when the daemon set the env — a
  // bare human `mrc team up` carries no predict and is unaffected. The inner mrc.js resolveStoreMode assert is a belt.
  if (process.env.MRC_MODEL_B_PREDICT != null) {
    const predict = process.env.MRC_MODEL_B_PREDICT === '1'
    const actual = decideModelB(imageIdAndLabels().labels)
    if (predict !== actual) throw new Error(`Model B mode mismatch: the daemon predicted ${predict ? 'Model B' : 'legacy'} but this image is ${actual ? 'Model B' : 'legacy'} — refusing the launch LOUD (a rebuild likely landed between define and launch; retry). Never mounting under a mode the daemon didn't expect.`)
  }
  const existing = (loadLaunches()[norm.org] || {}).members || {}
  const members = {}
  let nextPort = Number(process.env.MRC_TTYD_PORT) || 7681
  let already = true
  for (const m of live) {
    const prev = existing[m.handle]
    if (sessionAlive(prev)) { members[m.handle] = prev; continue }   // servable — keep it
    // #41: a live master with no servable socket = ORPHANED. Do NOT spawn (that's the re-entry that
    // orphans it — and spawnMemberSession now throws to enforce that). Keep the record + flag it; the
    // dashboard surfaces "Relaunch to restore" (which goes through killMember-first, then a fresh spawn).
    if (masterAliveForSock(memberSock(norm.org, m.handle))) { members[m.handle] = { ...(prev || {}), sock: memberSock(norm.org, m.handle), orphaned: true }; continue }
    already = false
    const port = await findFreePort(nextPort); nextPort = port + 1
    try {
      const entry = spawnMemberSession(norm.org, m.handle, port, memberShellCmd(repoPath, m, rosterPath, norm.org, { web }))
      // guard-4: fail LOUD if ttyd didn't actually bind a unix socket (a host ttyd change → TCP-0.0.0.0 fallback).
      // Throws (after SIGKILLing the ttyd) → the boundary catch flags this member orphaned, never a silent open port.
      await assertTtydUnixSocket(entry.ttydPid, entry.ttydSock)
      members[m.handle] = entry
    } catch (e) {
      // The unlink-guard throw / the guard-4 no-socket throw / any spawn failure must fail LOUD-but-CONTAINED: log +
      // flag this one member, never abort the whole team launch or crash the daemon's launch subprocess (#28 backstop
      // is last-resort; this is the explicit boundary catch).
      if (e && e.code === 'TTYD_NO_UNIX_SOCKET') {
        // guard-4 (Pierre): a no-socket failure is a VIEWER failure, not a SESSION failure — the dtach master is
        // ALIVE and reachable via the native console. And it's DETERMINISTIC: Relaunch re-spawns the same broken
        // ttyd → re-fails until the ROOT cause (host ttyd version / path length) is fixed. So point at both, and
        // stamp orphanReason so the dashboard can show "console door, don't Relaunch" instead of a dead-end Relaunch.
        console.error(`  ⚠ @${m.handle}'s TERMINAL can't start — ${e.message}\n     The SESSION is alive: reach it now with \`mrc team console ${m.handle}\`. Relaunch won't help until the host ttyd is fixed.`)
        members[m.handle] = { ...(prev || {}), sock: memberSock(norm.org, m.handle), orphaned: true, orphanReason: 'ttyd-no-unix-socket' }
      } else {
        console.error(`  ⚠ @${m.handle} not launched: ${e?.message || e}`)
        members[m.handle] = { ...(prev || {}), sock: memberSock(norm.org, m.handle), orphaned: true }
      }
    }
  }
  return { members, already }
}

// --- launch lifecycle (shared by `mrc team up` and the daemon's GUI launch) ----------------------
export function hasTtyd() { try { execFileSync('ttyd', ['--version'], { stdio: 'ignore' }); return true } catch { return false } }
// dtach has NO version flag: any invocation that isn't a real session prints usage and exits non-zero.
// So presence ≠ exit-zero — we only treat ENOENT (binary not on PATH) as missing; a non-zero exit means
// dtach IS installed (it just rejected our probe args).
export function hasDtach() { try { execFileSync('dtach', ['-V'], { stdio: 'ignore' }); return true } catch (err) { return err?.code !== 'ENOENT' } }
// #41: `pgrep` is now load-bearing — terminal liveness/teardown match the dtach master/viewer by their
// argv (drift-proof, pid-reuse-safe) via pgrep, not a stored pid. Without it, masterAliveForSock always
// reads false → NO member ever serves → every terminal silently shows orphaned/building (mimics the very
// bug #41 fixed). So fail LOUD at launch. (Probe pattern matches nothing → exit 1 = pgrep EXISTS; ENOENT
// = missing.) Standard on macOS + Linux (procps).
export function hasPgrep() { try { execFileSync('pgrep', ['-f', '__mrc_pgrep_presence_probe__'], { stdio: 'ignore' }); return true } catch (err) { return err?.code !== 'ENOENT' } }

// #34: the set of a team's members whose SESSION is alive (the dtach master — NOT the ephemeral ttyd
// viewer). Keyed by HANDLE; drives the daemon's launched-vs-online reconcile. A member is "launched"
// while its dtach master lives, regardless of whether any browser is attached.
export function launchedMemberHandles(org) {
  const mems = (loadLaunches()[org] || {}).members || {}
  const s = new Set()
  for (const [h, info] of Object.entries(mems)) if (sessionAlive(info)) s.add(h)
  return s
}
// Per-member terminal view for the dashboard: handle -> { ttydPort, ttydUrl, state }. `state` is the #41
// 4-state classification (serve/starting/orphaned/dead) — container-anchored + fail-toward-starting. The
// reconcile passes live facts: repo (for the container probe), the set of ONLINE handles, and whether the
// launch is within the build grace. One `docker ps` per call (the container probe).
export function memberTtyds(org, { repo, onlineHandles, withinGrace } = {}) {
  const mems = (loadLaunches()[org] || {}).members || {}
  const liveContainers = dockerMemberHandles(org)   // #49 multi-repo: probe by mrc.project=<org>, not repo (cross-repo members carry mrc.repo=member.repo). `repo` kept in the signature for caller compat.
  const out = {}
  for (const [h, info] of Object.entries(mems)) {
    const state = classifyTerminal(info, { containerAlive: liveContainers.has(h), online: onlineHandles?.has(h), withinGrace })
    // guard-4: the terminal URL is now the SAME-ORIGIN proxy path (`/ttyd/<org>/<handle>/`) the dashboard serves —
    // NOT a `http://127.0.0.1:<port>/` TCP URL (that residual would re-expose the CSWSH). Relative → resolves
    // against the dashboard's own origin, so the dashboard's Origin/Host gate + frame-ancestors protect it.
    out[h] = { ttydUrl: info.ttydSock ? `/ttyd/${encodeURIComponent(org)}/${encodeURIComponent(h)}/` : null, state }
  }
  return out
}
// Stop a team. Order: reap the host plumbing (ttyd viewer + dtach master) → `docker kill` the member
// CONTAINER by label (load-bearing — the detached container can outlive the master, #1) → unlink the
// socket last. #41: reap by the deterministic sock PATH (+ container by label), NOT the persisted
// dtachPid/ttydPid — a recycled stale pid would mis-kill an unrelated host process (and miss the real
// one on record drift). Use the deterministic memberSock(org,handle), not the stored info.sock.
export function killTeamSession(org) {
  const rec = loadLaunches()[org] || {}
  const mems = rec.members || {}
  let any = false
  for (const handle of Object.keys(mems)) {
    const sock = memberSock(org, handle)
    if (killHostPlumbingForSock(sock)) any = true
    dockerKillMember(org, handle)   // #49 multi-repo: kill by mrc.project=<org>, not rec.repo (finds a cross-repo member's container)
    try { unlinkSync(sock) } catch {}
    try { unlinkSync(memberTtydSock(org, handle)) } catch {}   // guard-4: also reap the ttyd unix socket (killHostPlumbingForSock already killed ttyd via its `dtach -a` cmdline match)
  }
  // #41: clear the launch record on an INTENTIONAL stop (matches the dashboard "Stop team" path), so a
  // deliberately-`down`ed team reads launchable immediately instead of a stale `building`/`starting` for
  // up to the grace window. A CRASH never calls this, so it keeps its record → the safe orphaned/transient.
  removeLaunch(org)
  return any
}

// Build the image once, then launch each live member as its own dtach session + ttyd viewer; persist the
// per-member registry. dtach (holds the session) AND ttyd (serves the browser terminal) are both REQUIRED
// — no tmux fallback. Returns { ok, members, already, live }.
export async function startTeamSession(norm, repoPath, { rosterPath, web = false } = {}) {
  const live = norm.members.filter((m) => m.tier === 'live')
  if (!live.length) return { ok: false, error: 'no live members to launch' }
  if (!hasTtyd()) return { ok: false, error: 'ttyd not found — it now hosts each member terminal (brew install ttyd / apt install ttyd)' }
  if (!hasDtach()) return { ok: false, error: 'dtach not found — it keeps each member session alive across console switches (brew install dtach / apt install dtach)' }
  if (!hasPgrep()) return { ok: false, error: 'pgrep not found — required for terminal liveness detection; without it NO member terminal can serve (install procps: apt install procps — standard on macOS + Linux)' }
  try {
    const { ensureDocker } = await import('../colima.js')
    const { buildImage } = await import('../docker.js')
    const { resolveContextDir } = await import('../context.js')
    await ensureDocker(false, {})
    buildImage(resolveContextDir(dirname(MRC_JS)), { rebuild: false, verbose: false, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 })
  } catch (e) { /* members will each build on their own */ }
  const { members, already } = await launchMembers(norm, repoPath, rosterPath, live, { web })
  saveLaunch(norm.org, { repo: repoPath, members })
  return { ok: true, members, already, live: live.map((m) => ({ handle: m.handle, first: m.first, role: m.role })) }
}

// #49: born-detachable SOLO launch. Like startTeamSession but for the single self-deriving solo member —
// the dtach master runs `mrc <repo> --solo --member you/claude`, which self-derives via soloRoster (no
// team.json), so the browser (ttyd) and the native terminal (`dtach -a`) attach to ONE session. Returns
// { ok, sock, ttydPort, already } on the dtach path, or { ok:false, fallback:true } when ttyd/dtach/pgrep
// are missing — the caller then runs a plain FOREGROUND solo member (native terminal only, no browser), so
// solo adds NO new hard dependency for the plain-terminal case.
const soloShellCmd = (repoPath) =>
  `node ${[MRC_JS, repoPath].map(shq).join(' ')} --solo --member ${shq(SOLO_HANDLE)}; echo; echo ${shq('[solo session exited — press enter]')}; read`

export async function startSoloSession(repoPath) {
  if (!hasTtyd() || !hasDtach() || !hasPgrep()) return { ok: false, fallback: true }
  const norm = soloRoster(repoPath)
  const res = await pushOrg(norm)   // define the personal org so the daemon binds the member when it registers
  if (!res.ok) return { ok: false, error: res.error || 'daemon unreachable' }
  const existing = (loadLaunches()[norm.org] || {}).members || {}
  const prev = existing[SOLO_HANDLE]
  if (sessionAlive(prev)) return { ok: true, sock: prev.sock, already: true }   // idempotent relaunch
  // #41 guard: never spawn over a live-but-unservable master (that orphans it). Recovery is a dashboard Relaunch.
  if (masterAliveForSock(memberSock(norm.org, SOLO_HANDLE))) return { ok: false, error: 'a solo session master is already live but unservable — Relaunch from the dashboard (it stops the stale master first)' }
  // THIN outer (Pierre seam-a): do NOT start Colima or build the image here — the INNER `mrc --member` is a
  // full normal launch that starts the VM, builds, owns the proxies + teardown. The outer only spawns the
  // dtach master + ttyd and exits, so it can never stop the VM out from under the inner's container (the
  // cold-start race). The first solo launch shows the build inside the attached session (like `mrc team up`).
  const port = await findFreePort(Number(process.env.MRC_TTYD_PORT) || 7681)
  let info
  try { info = spawnMemberSession(norm.org, SOLO_HANDLE, port, soloShellCmd(repoPath)) }
  catch (e) { return { ok: false, error: String(e?.message || e) } }
  saveLaunch(norm.org, { repo: repoPath, members: { [SOLO_HANDLE]: info } })
  return { ok: true, sock: info.sock }
}

// Reconstruct a PINNED team.json from a normalized org def — every member keeps its assigned name —
// so re-parsing is stable (adding a member won't renumber/rename the existing ones).
export function rosterFromDef(def) {
  const teams = {}
  for (const m of (def?.members || [])) {
    if (!teams[m.team]) teams[m.team] = { name: m.team, members: [] }
    const mm = { name: m.first, role: m.role, backend: m.backend }
    if (m.lead) mm.lead = true
    if (m.territory && m.territory !== '.') mm.territory = m.territory
    // Model B: carry the member's explicit authorized repo — a rebuilt roster MUST re-supply it (parseRoster's
    // modelB branch requires an explicit member.repo; there's no org-root default). Harmless for legacy: an own-repo
    // member's m.repo === repoPath re-parses to the own-repo grant (byte-identical); a cross-repo member's authorized
    // repo re-parses through the set (already authorized). So carrying it is safe in BOTH modes.
    if (m.repo) mm.repo = m.repo
    // #43: carry the picked SESSION + its owner-ref through the roster reconstruction. rosterFromDef feeds BOTH the
    // anchor's team.json (writeTeamFile) AND relaunchmember (materializeRoster(rosterFromDef(def))) — and findRoster
    // PREFERS team.json over team.runtime.json, so without this a relaunch (or any team.json read) drops the picked
    // session and the agent silently re-starts fresh instead of resuming the grafted conversation. Same drop-class as
    // `cage` (which the engine projection also stripped): a reconstruction that omits a load-bearing field.
    if (m.session) mm.session = m.session
    if (m.sessionRef) mm.sessionRef = m.sessionRef
    // CONTAINMENT (the drop-class the comment above named but never carried): `cage` MUST survive the
    // reconstruction. All three of a caged member's egress belts derive from member.cage — memberArgv's --web
    // skip, mrc.js cagedAdversary→allowWeb=false, and MRC_ADVERSARY_FW→firewall 443-drop — via the --member-def
    // blob. Dropping cage here re-launches a caged member UNCAGED on the relaunch path (relaunchmember →
    // materializeRoster(rosterFromDef(def))): rw /workspace, no SNI-pin, AND (with #57 web on) open 443. Carrying
    // it only ever RESTRICTS (parseRoster re-runs assertCageAllowed), never elevates. Pre-existing latent bug;
    // #57's per-project --web would have turned it into an egress leak.
    if (m.cage) mm.cage = m.cage
    teams[m.team].members.push(mm)
  }
  const roster = { org: def?.org, repo: def?.repo, teams: Object.values(teams) }
  // #43: carry the custom `personas` block so a REBUILT roster keeps custom-role charters. The in-memory def doesn't
  // store personas; team.json on disk is their authoritative home. Read it from the SAME place defineOrg WROTE it:
  // the unmounted ANCHOR under Model B (def.anchor), the repo under legacy (def.repo). Model B security payoff — the
  // anchor is host-only + never-mounted, so a member container CANNOT tamper the team.json personas are read from →
  // the persona-injection vector (guard-2 / crack B) is SUBSUMED by the anchor's un-mountedness, the same way the pin
  // and activation are subsumed by the authorized-set. (Legacy still reads the repo team.json — guard-2 remains its
  // separately-tracked concern there.)
  try {
    const personaSrc = def?.anchor || def?.repo
    if (personaSrc) {
      const tj = JSON.parse(readFileSync(join(personaSrc, 'team.json'), 'utf8'))
      if (tj && tj.personas && typeof tj.personas === 'object' && !Array.isArray(tj.personas) && Object.keys(tj.personas).length) roster.personas = tj.personas
    }
  } catch {}
  return roster
}

// Remove a member from a roster by handle; drop any team left empty. Returns a copy.
export function removeMemberFromRoster(roster, handle) {
  const r = JSON.parse(JSON.stringify(roster || { teams: [] }))
  const h = String(handle).toLowerCase()
  for (const t of (r.teams || [])) t.members = (t.members || []).filter((m) => makeHandle(m.name, m.backend) !== h)
  r.teams = (r.teams || []).filter((t) => (t.members || []).length)
  return r
}

// Keep the repo's team.json in sync with the live project (written as { project, personas?, teams }).
// #51: PRESERVE the custom `personas` block. The daemon's roster-sync rebuilds {project,teams} from the
// live def (rosterFromDef), which doesn't carry personas — so without this, any define/add/remove/launch
// would silently ERASE the personas the editor wrote here (the data-loss that made @user's persona vanish).
// Prefer the roster's own personas; else keep whatever is already on disk. Atomic, like the other two
// team.json writers (temp→fsync→rename) so a kill mid-sync can't tear the authoritative file.
export function writeTeamFile(repo, roster) {
  // #49: a SOLO org is DERIVED + ephemeral (soloRoster — it reads no roster file and has no team.json home),
  // so it must NEVER be persisted here. The daemon syncs EVERY defined org (defineOrg → writeTeamFile,
  // room-daemon.js), so without this guard a plain `mrc <repo> --solo` clobbers the repo's real, hand-authored
  // team.json with the one-member solo roster (a data-loss bug surfaced by the owner's --solo smoke). team.json
  // belongs to declared teams only; skip solo orgs at this single chokepoint.
  if (RESERVED_SOLO_ORG_RE.test(String(roster?.org || roster?.project || ''))) return false
  try {
    const file = join(repo, 'team.json')
    let personas = roster.personas
    if (personas == null) {
      try { const cur = JSON.parse(readFileSync(file, 'utf8')); if (cur && cur.personas && typeof cur.personas === 'object' && !Array.isArray(cur.personas)) personas = cur.personas } catch {}
    }
    const out = { project: roster.org, ...(personas && Object.keys(personas).length ? { personas } : {}), teams: roster.teams }
    atomicWriteFileSync(file, JSON.stringify(out, null, 2) + '\n')
    return true
  } catch { return false }
}

// #41: stop one member's session — reap the host plumbing by deterministic sock PATH (master + ttyd +
// viewers; NOT the persisted pids, which can be stale/recycled → mis-kill), `docker kill` the container by
// label, unlink the socket, drop from the registry. The kill-first half of the Relaunch recovery, so it
// must be drift-proof + idempotent against an orphaned-live container.
export function killMember(org, handle) {
  const sock = memberSock(org, handle)
  killHostPlumbingForSock(sock)
  dockerKillMember(org, handle)   // #49 multi-repo: kill by mrc.project=<org>, not rec.repo (finds a cross-repo member's container)
  try { unlinkSync(sock) } catch {}
  try { unlinkSync(memberTtydSock(org, handle)) } catch {}   // guard-4: reap the ttyd unix socket too
  removeMemberLaunch(org, handle)
  return true
}

// Append a member to a roster (returns a copy). The new member is UNPINNED, so it draws a fresh
// deterministic name; call this on a PINNED roster (rosterFromDef) so existing members keep theirs.
export function addMemberToRoster(roster, teamName, member) {
  const r = JSON.parse(JSON.stringify(roster || { teams: [] }))
  r.teams = r.teams || []
  let team = r.teams.find((t) => t.name === teamName)
  if (!team) { team = { name: teamName || 'team', territory: '.', members: [] }; r.teams.push(team) }
  team.members = team.members || []
  const m = { role: member.role || 'engineer', backend: member.backend || 'claude' }
  if (member.lead) m.lead = true
  if (member.territory) m.territory = member.territory
  // #45: an added agent carries its OWN repo (Model B requires it — each agent picks its own authorized repo).
  // parseRoster's resolveMemberRepo gates it against the org's human-authorized set downstream, so an
  // unauthorized repo is rejected at the mint (the dashboard authorizes the picked repo first, human-gated).
  if (member.repo) m.repo = member.repo
  // P3: an OPTIONAL explicit name (e.g. a cast-picked "Colette") — parseRoster validates it downstream
  // (assertSafeName + org-wide handle-uniqueness), so a bad/duplicate name is rejected at the mint, exactly
  // like the create-form. Absent → parseRoster deterministically auto-assigns a free name (existing behavior).
  if (member.name && String(member.name).trim()) m.name = String(member.name).trim()
  team.members.push(m)
  return r
}

// #34: launch ONE member into an already-running org as its own dtach session + ttyd viewer (image
// already built — safe from the daemon). No-op if the team isn't launched or the member's session is up.
export async function launchMember(org, repoPath, rosterPath, member, { web = false } = {}) {
  const rec = loadLaunches()[org]
  if (!rec) return { ok: false, error: 'team not launched' }
  const prev = (rec.members || {})[member.handle]
  if (sessionAlive(prev)) return { ok: true, already: true }
  // #41: never spawn over a live master (orphans it). If one's alive but unservable, it's orphaned —
  // recovery is a Relaunch that kills it first (relaunchMember), not a bare re-spawn here.
  if (masterAliveForSock(memberSock(org, member.handle))) return { ok: false, error: 'session orphaned — use Relaunch (stops the live master first) to restore the terminal', orphaned: true }
  try {
    const port = await findFreePort(Number(process.env.MRC_TTYD_PORT) || 7681)
    setMemberLaunch(org, member.handle, spawnMemberSession(org, member.handle, port, memberShellCmd(repoPath, member, rosterPath, org, { web })))
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

// #56 (Pierre fork B): spawn a CAGED transient-consult Pierre into an ALREADY-RUNNING team as its own dtach
// session + ttyd viewer — the caged-member launch primitive PLUS a boot PROMPT. A fresh session sits idle on a
// pushed message (it takes no turn until prompted), so the positional `-- <prime>` gives Pierre a kickoff turn to
// read its brief + open the volley, exactly like the legacy summon's adversaryPrime. Everything security-bearing
// is HOST-BUILT by the daemon (onSummonIntoTeam) and rides the --member-def blob (container-untamperable):
//   • handle in the reserved "."-keyspace (engine keyspace gate; SAFE_NAME-disjoint from real members)
//   • cage:'adversary' → mrc.js memberCageIsAdversary → cagedAdversary (ro /workspace, SNI seal, adversary:true
//     record, MRC_ADVERSARY_FW, no /mrc, forced allowWeb=false) — all three egress belts + identity isolation
//   • repo = the SUMMONER's repo (V1: from the summoner's host record, never a wire value) — mounted :ro
//   • territory:'.' (inert — memberWorkspaceVolumes's `if(member.cage)` is ro-only, never reads territory)
//   • consultRooms:[consultId] (the daemon's OWN addTransientConsult roomId) → mrc.js caged /rooms mount
// NO --web (caged; memberArgv drops it for member.cage anyway). rosterPath is the TEAM's real roster (display-only;
// identity is 100% the blob, and Pierre's team:null persona filter yields no teammates → it leaks nothing).
export async function launchTransientConsult(org, summonerRepo, rosterPath, member, prime) {
  // Never spawn over a live master (orphans it) — a re-summon must dismiss the prior Pierre first (removeTransientConsult
  // → killMember), same #41 discipline as launchMember. If one's alive, refuse LOUD rather than orphan it.
  if (masterAliveForSock(memberSock(org, member.handle))) return { ok: false, error: 'a Pierre session already holds this consult slot — dismiss it first', orphaned: true }
  try {
    const port = await findFreePort(Number(process.env.MRC_TTYD_PORT) || 7681)
    // memberArgv builds the caged inner launch from the blob (`{...member, org, crossRepo}`), so cage/consultRooms/
    // territory all ride into --member-def. Append `-- <prime>` as the boot turn (claudeArgs → entrypoint "$@").
    const argv = [...memberArgv(summonerRepo, member, rosterPath, org, { web: false }), '--', String(prime || '')]
    const shellCmd = `node ${argv.map(shq).join(' ')}; echo; echo ${shq(`[@${member.first || 'Pierre'} exited — press enter]`)}; read`
    const entry = spawnMemberSession(org, member.handle, port, shellCmd)
    await assertTtydUnixSocket(entry.ttydPid, entry.ttydSock)   // guard-4: fail LOUD if ttyd didn't bind a unix socket
    setMemberLaunch(org, member.handle, entry)
    return { ok: true, entry }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

// Parse a roster (object or JSON string), write it to <repo>/.mrc/team.runtime.json so launched
// members can --roster it, and return { norm, rosterPath }. Used by the daemon's GUI launch.
export function materializeRoster(rosterInput, repoHint, modelB = false) {
  const norm = parseRoster(rosterInput, { repo: repoHint, modelB, cwdFallback: false })   // Model B: norm.repo becomes the neutral anchor (parseRoster), so the runtime roster + launch.log land there, not in a repo. cwdFallback:false — a LAUNCH never roots at the daemon's cwd; a repo-less legacy launch fails closed (Pierre landmine).
  // Model B: norm.repo is the neutral ANCHOR (host-only, mrc-owned) — and materializeRoster runs BEFORE defineOrg,
  // so nothing has created it yet. canonicalWriteTarget below realpaths the root → ENOENT if it doesn't exist. Create
  // it here (safe: it's mrc's own hex-keyed dir, never a user repo — legacy norm.repo is a real repo that already
  // exists, so this is modelB-gated). Without this, EVERY Model B launch throws at the first write. (Caught pre-rebuild.)
  if (modelB) { mkdirSync(norm.repo, { recursive: true }); try { chmodSync(norm.repo, 0o700) } catch {} }   // 0700: the anchor holds the project's TG token .env (a SECRET) — un-mounted keeps it out of containers, 0700 keeps it out of cross-uid HOST processes (same load-bearing dir-perm as guard-4's socket dir). LOAD-BEARING, not deferrable (Pierre).
  // #49 (Pierre — the enumeration's reachable miss): route the runtime-roster write through the canonical
  // guard. Plain writeFileSync FOLLOWS a symlinked `.mrc -> /etc` (and mkdirSync on the existing symlink-dir
  // succeeds silently), and this runs on every `mrc team up` AND the daemon's GUI launch — same `.mrc` symlink
  // class as writePersonaFile, just a different write site.
  const rosterPath = canonicalWriteTarget(norm.repo, join('.mrc', 'team.runtime.json'))
  mkdirSync(dirname(rosterPath), { recursive: true })
  writeFileSync(rosterPath, typeof rosterInput === 'string' ? rosterInput : JSON.stringify(rosterInput, null, 2))
  return { norm, rosterPath }
}

// #49 multi-repo: resolve an org NAME from a team dir WITHOUT parseRoster. parseRoster runs resolveMemberRepo,
// which THROWS on a not-yet-authorized cross-repo member — and `mrc team repos add` is precisely how you authorize
// it (chicken-and-egg). So read only the project/org label, defaulting to the sanitized basename — the SAME org
// derivation parseRoster uses (roster.js:152-153), minus the member.repo resolution.
function readOrgName(repoPath, rosterFlag) {
  const path = rosterFlag || findRoster(repoPath)
  if (path) {
    try {
      const d = JSON.parse(readFileSync(path, 'utf8'))
      const ex = d.project || d.org
      if (ex) return assertSafeProjectName(ex, 'project')
    } catch {}
  }
  return sanitizeProjectName(basename(repoPath)) || 'org'
}

// #49 multi-repo: the HUMAN control-plane over an org's authorized-repo set (repo-auth.js). PURE over the
// host-only record — NEVER a session-callable verb: a session may REQUEST a repo (an @user inbox item), but a
// human AUTHORIZES it here (dashboard CSRF / this CLI). Returns a result the CLI renders + exits on. The floor's
// own guards apply (addAuthorizedRepo realpaths + broad-guards `/`/$HOME → throws, surfaced as a clean error).
export function reposAction(sub, org, repoArg) {
  const list = () => [...loadAuthorizedRepos(org)]
  switch ((sub || 'ls').toLowerCase()) {
    case 'ls': case 'list':
      return { ok: true, action: 'ls', org, repos: list() }
    case 'add': {
      if (!repoArg) return { ok: false, action: 'add', org, error: 'usage: mrc team repos add <repo> [team-path]' }
      let added; try { added = addAuthorizedRepo(org, repoArg) } catch (e) { return { ok: false, action: 'add', org, error: String(e?.message || e) } }
      return { ok: true, action: 'add', org, added, repos: list() }
    }
    case 'rm': case 'remove': {
      if (!repoArg) return { ok: false, action: 'rm', org, error: 'usage: mrc team repos rm <repo> [team-path]' }
      const removed = removeAuthorizedRepo(org, repoArg)
      return removed
        ? { ok: true, action: 'rm', org, removed: repoArg, repos: list() }
        : { ok: false, action: 'rm', org, error: `"${repoArg}" was not in org "${org}"'s authorized set`, repos: list() }
    }
    default:
      return { ok: false, action: sub, org, error: `unknown: mrc team repos ${sub} (use: add | ls | rm)` }
  }
}

export async function teamCommand(argv, { web = false } = {}) {   // #57: `web` = config.allowWeb, threaded by mrc.js (parseArgs strips --web from argv, so it can't be read here)
  const sub = argv[0] || 'status'
  const rest = argv.slice(1)
  const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : null }
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1]?.startsWith('--')))
  const repoPath = resolve(positional[0] || '.')
  const rosterFlag = flag('--roster')

  switch (sub) {
    case 'help': case '-h': case '--help':
      console.log(`mrc team — assemble and launch a team of agents

  mrc team up      [path] [--roster f | --preset name]   define + launch live members (dtach + ttyd)
  mrc team status  [path]                show the org, rooms, and @user inbox
  mrc team console <handle> [path]       attach to a running member's terminal
  mrc team down    [path]                close the org's rooms
  mrc team define  [path] [--roster f | --preset name]   define rooms WITHOUT launching
  mrc team presets                       list the ready-made team presets
  mrc team new --preset <name> [path]    write a team.json from a preset
  mrc team repos   [ls]  [team-path]     list repos this org's members may live in (multi-repo)
  mrc team repos   add <repo> [team-path]   authorize a repo (HUMAN act; a member can then set "repo":"…")
  mrc team repos   rm  <repo> [team-path]   revoke an authorized repo

Roster (team.json in the repo, or --roster <file>, or --preset <name>):
  { "org":"shop", "teams":[ { "name":"client", "territory":"client",
      "members":[ {"role":"architect","backend":"claude","lead":true},
                  {"role":"writer","backend":"claude"},
                  {"role":"critic","backend":"claude"} ] } ] }`)
      return

    case 'presets': {
      console.log('  Team presets (use with `mrc team up --preset <name>` or `mrc team new --preset <name>`):')
      for (const p of listPresets()) console.log(`    ${p.name.padEnd(9)} ${p.title} — ${p.description}`)
      return
    }

    case 'new': {
      const preset = flag('--preset')
      if (!preset) { console.error(`Usage: mrc team new --preset <name> [path]\n  presets: ${Object.keys(PRESETS).join(', ')}`); process.exit(1) }
      let roster; try { roster = buildPreset(preset, { org: basename(repoPath) }) } catch (e) { console.error(`  ✗ ${e.message}`); process.exit(1) }
      mkdirSync(repoPath, { recursive: true })   // ensure the repo dir exists before canonicalizing within it
      // #49 (Pierre — narrow, same class): a symlinked `team.json -> <nonexistent>` slips past existsSync (broken
      // symlink reads false) and plain writeFileSync would create the target THROUGH the link. Canonicalize it.
      let file; try { file = canonicalWriteTarget(repoPath, 'team.json') } catch (e) { console.error(`  ✗ ${e.message}`); process.exit(1) }
      if (existsSync(file)) { console.error(`  ✗ ${file} already exists — edit it, or delete it first.`); process.exit(1) }
      writeFileSync(file, JSON.stringify(roster, null, 2) + '\n')
      console.log(`  ◎ Wrote ${file} from preset "${preset}". Edit it, then \`mrc team up\` (or \`mrc team up --preset ${preset}\`).`)
      return
    }

    case 'up': case 'define': {
      const presetFlag = flag('--preset')
      let norm, path
      try {
        if (presetFlag) {
          const roster = buildPreset(presetFlag, { org: basename(repoPath) })
          ;({ norm, rosterPath: path } = materializeRoster(roster, repoPath))
        } else {
          ({ norm, path } = loadRoster(repoPath, rosterFlag))
        }
      } catch (e) { console.error(`  ✗ ${e.message}`); process.exit(1) }   // #36: clean error for a rejected name (etc.), not a stack
      const v = validateRoster(norm)
      for (const w of v.warnings) console.log(`  ⚠ ${w}`)
      if (!v.ok) { for (const e of v.errors) console.error(`  ✗ ${e}`); process.exit(1) }
      const res = await pushOrg(norm)
      if (!res.ok) { console.error(`  ✗ Could not define the org with the daemon: ${res.error || 'unreachable'}`); process.exit(1) }
      console.log(`  ◎ Org "${norm.org}" defined: ${res.rooms.length} room(s), ${norm.members.length} member(s).`)
      const live = norm.members.filter((m) => m.tier === 'live')
      const workers = norm.members.filter((m) => m.tier !== 'live')
      if (workers.length) console.log(`  • ${workers.length} worker member(s) (${workers.map((m) => '@' + m.handle).join(', ')}) — invoked on demand, not launched.`)
      if (sub === 'define') { console.log('  ◎ Defined (not launched). Run `mrc team up` to launch.'); return }
      if (!live.length) { console.log('  (no live members to launch)'); return }
      if (!hasTtyd() || !hasDtach() || !hasPgrep()) {
        const missing = [!hasTtyd() && 'ttyd', !hasDtach() && 'dtach', !hasPgrep() && 'pgrep'].filter(Boolean).join(' + ')
        console.log(`  ${missing} not found — ttyd hosts each member terminal, dtach keeps its session alive across`)
        console.log('  console switches, and pgrep drives terminal-liveness detection (without it NO terminal can serve).')
        console.log('  Install (brew install ttyd dtach / apt install ttyd dtach procps) and relaunch, or run a member directly:')
        for (const m of live) console.log(`      node ${memberArgv(repoPath, m, path, norm.org).join(' ')}`)
        return
      }
      const r = await startTeamSession(norm, repoPath, { rosterPath: path, web })   // #57: per-project egress — `web` (config.allowWeb) is threaded from mrc.js; the daemon spawns `mrc team up … --web` when the org's web setting is on
      if (!r.ok) { console.error(`  ✗ ${r.error}`); process.exit(1) }
      console.log(r.already
        ? '  ◎ team already running — its member terminals are up in the dashboard Console:'
        : `  ◎ Launched ${live.length} member(s), each with its own terminal in the dashboard Console:`)
      for (const m of live) {
        console.log(`      @${m.first}/${m.backend}  (${m.roleLabel}${m.lead ? ', lead' : ''}, ${m.team})`)
      }
      // guard-4: terminals are served ONLY same-origin behind the dashboard proxy now (ttyd listens on a unix
      // socket, no TCP port) — a stray page can no longer reach them directly. Open them via the dashboard.
      console.log('\n  Open them:  mrc dashboard   (each terminal is embedded there — no direct URL by design).')
      console.log('  A member logs in on its first launch in a fresh config.')
      return
    }

    case 'status': {
      const meta = readMeta()
      if (!meta) { console.log('  No room daemon running. Start with `mrc team up`.'); return }
      const r = await controlCall(meta.controlPort, { action: 'team' })
      if (!r?.ok) { console.log('  Daemon unreachable.'); return }
      if (!r.rooms?.length) { console.log('  No team rooms defined. Run `mrc team up`.'); return }
      console.log(`  Members:`)
      for (const m of r.members) console.log(`    @${m.handle}  ${m.role}${m.lead ? ' (lead)' : ''}  ${m.team}  ${m.online ? '● online' : '○ offline'}  [${m.tier}]`)
      console.log(`  Rooms:`)
      for (const rm of r.rooms) console.log(`    ${rm.team || rm.roomId} [${rm.kind}]  ${rm.state}  turn ${rm.turn}  · ${rm.members.filter((x) => x !== '@user').length} members`)
      if (r.userInbox?.length) {
        console.log(`  @user inbox (${r.userInbox.filter((x) => !x.answered).length} unanswered):`)
        for (const it of r.userInbox) console.log(`    [${it.i}] ${it.answered ? '✓' : '•'} ${it.fromName} (${it.room}): ${it.text.slice(0, 80)}`)
      }
      return
    }

    case 'console': {
      const handle = rest[0]
      if (!handle) { console.error('Usage: mrc team console <handle|first-name> [path]'); process.exit(1) }
      const { norm } = loadRoster(repoPath, rosterFlag)
      const m = norm.members.find((x) => x.handle === handle.toLowerCase() || x.first.toLowerCase() === handle.toLowerCase())
      if (!m) { console.error(`No member "${handle}" in the roster — run \`mrc team status\` to list members.`); process.exit(1) }
      // #34 chunk C: attach to the member's LIVE dtach master (read-write, mouse-wheel intact), keyed by
      // org+handle from the launch registry so two projects sharing a handle never collide. `dtach -a`
      // re-attaches the SAME session (does NOT spawn a second master). No -E here (unlike the ttyd viewer):
      // a CLI attach WANTS the Ctrl-\ detach key so you can leave the member running; -E only gates that
      // one key, so the wheel/mouse still pass through either way.
      if (!hasDtach()) { console.error('  dtach not found — it holds each member session alive across console attaches (brew install dtach / apt install dtach).'); process.exit(1) }
      const info = ((loadLaunches()[norm.org] || {}).members || {})[m.handle]
      if (!sessionAlive(info)) {
        console.error(`  @${m.first} has no running session for "${norm.org}" — run \`mrc team up\` first, or open it in the dashboard Console.`); process.exit(1)
      }
      console.log(`  Attaching to @${m.first} (${norm.org}) — detach with Ctrl-\\ (the member keeps running).`)
      const r = spawnSync('dtach', ['-a', info.sock, '-r', 'winch'], { stdio: 'inherit' })
      process.exit(r.status || 0)
    }

    case 'exec': case '_worker-exec': {
      // `mrc team exec <handle> "prompt" [path]` runs a worker turn manually; `_worker-exec` is the
      // daemon's internal entry (handle/repo via flags, prompt on stdin).
      const handle = sub === 'exec' ? rest[0] : flag('--handle')
      const repo = flag('--repo') ? resolve(flag('--repo')) : repoPath
      if (!handle) { console.error('Usage: mrc team exec <handle> ["prompt"] [path]'); process.exit(1) }
      // #49-SEC (Mouth A): the worker's container mount/territory/repo (memberWorkspaceVolumes(member)) must come
      // from an AUTHORITATIVE member, not a member-writable roster. The daemon's _worker-exec passes --member-def
      // (the engine's authoritative member) → use it WHOLESALE and never parse the roster at all. A manual
      // `mrc team exec` (no blob) falls back to findRoster, now sourced only from RO-to-members locations (the
      // rw `.mrc/team.json` candidate was dropped in rosterCandidates). execWorker ignores `norm` (mount is from
      // `member`), so a null norm on the blob path is fine.
      const memberDef = flag('--member-def')
      let member, norm
      if (memberDef) {
        try { member = resolveMemberIdentity({ solo: false, memberDef }, null, String(handle).toLowerCase()) }
        catch (e) { console.error(`  ✗ Refusing to run worker: ${e?.message || e}.`); process.exit(1) }
      } else {
        ;({ norm } = loadRoster(repo, rosterFlag))
        member = norm.members.find((m) => m.handle === handle.toLowerCase() || m.first.toLowerCase() === handle.toLowerCase())
      }
      if (!member) { console.error(`No member "${handle}" in the roster.`); process.exit(1) }
      let prompt = sub === 'exec' ? rest.slice(1).filter((a) => !a.startsWith('--')).join(' ') : ''
      if (!prompt) prompt = await readStdin()
      if (!prompt.trim()) { console.error('No prompt (positional arg or stdin).'); process.exit(1) }
      // #48: print the worker's output, then EXIT NON-ZERO on a failed call so the daemon's
      // spawnWorkerInvoke rejects (→ threw → ✕ in the call-history) instead of swallowing the failure as
      // exit 0. Applies to both the daemon's _worker-exec and a manual `mrc team exec` (proper shell semantics).
      const wr = await execWorker(norm, member, repo, prompt)
      process.stdout.write(wr.text)
      process.exit(wr.ok ? 0 : 1)
    }

    case 'down': {
      const meta = readMeta()
      if (!meta) { console.log('  No room daemon running.'); return }
      const { norm } = loadRoster(repoPath, rosterFlag)
      let closed = 0
      for (const rm of norm.rooms) { const r = await controlCall(meta.controlPort, { action: 'end', roomId: rm.roomId }); if (r?.ok) closed++ }
      console.log(`  ◎ Closed ${closed} room(s) for org "${norm.org}". (Member terminals stay open; close them when done.)`)
      return
    }

    case 'repos': {
      // `mrc team repos [ls]` | `mrc team repos add <repo> [team-path]` | `mrc team repos rm <repo> [team-path]`
      // The HUMAN authorizes which repos an org's members may live in (a session can only REQUEST one). The org is
      // read from the team dir WITHOUT parseRoster (which would throw on the very unauthorized member you're adding).
      const action = (positional[0] || 'ls').toLowerCase()
      const isLs = action === 'ls' || action === 'list'
      const repoArg = isLs ? null : positional[1]
      const teamPath = resolve((isLs ? positional[1] : positional[2]) || '.')
      const org = flag('--org') ? assertSafeProjectName(flag('--org'), 'org') : readOrgName(teamPath, rosterFlag)
      const r = reposAction(action, org, repoArg ? resolve(repoArg) : null)
      if (!r.ok) { console.error(`  ✗ ${r.error}`); process.exit(1) }
      if (r.action === 'add') console.log(`  ✓ Authorized ${r.added} for org "${org}". A member may now declare "repo": "${r.added}" (authorizing is a human act — a session can only request one).`)
      else if (r.action === 'rm') console.log(`  ✓ Removed ${r.removed} from org "${org}"'s authorized repos.`)
      console.log(`  Cross-repos authorized for org "${org}" (${r.repos.length}):`)
      if (!r.repos.length) console.log(`    (none — members use the org's own repo; add one with \`mrc team repos add <repo>\`)`)
      else for (const p of r.repos) console.log(`    • ${p}`)
      return
    }

    default:
      console.error(`Unknown team command: ${sub}. Try: mrc team help`)
      process.exit(1)
  }
}

// Build the launch wiring for a single member (called from mrc.js when --member is set). Returns
// { envFlags, volumes, sessionId, persona } — pure given the roster/member; writes the persona file.
export function memberLaunch(norm, member, repoPath) {
  // #49 multi-repo (Mouth B): a member's launch is rooted at its OWN repo — persona-write AND workspace-mount both
  // resolve to member.repo (the authorized value), so they can never disagree. For an own-repo member member.repo
  // === repoPath → byte-identical to today. In the inner the passed repoPath IS member.repo anyway; keying both off
  // member.repo makes the coherence explicit rather than resting on the caller passing the matching repoPath.
  const root = member.repo || repoPath
  const persona = personaForMember(norm, member)
  const personaPath = writePersonaFile(root, member, persona)
  return {
    envFlags: memberEnv(member, personaPath),
    workspaceVolumes: memberWorkspaceVolumes(member, root),
    // #49-SEC: the sessionId (→ daemon bind) keys on `member.org`, which the caller sets AUTHORITATIVELY — the
    // host-set --member-def blob for a team member (immune to a re-tampered on-disk roster), or the repo-derived
    // soloRoster org for solo. NO `|| norm.org` backstop: a roster-parsed org must NEVER backstop a missing
    // authoritative one (that reopens the door); a missing member.org yields a bind-to-nothing id (fail-closed).
    // memberWorkspaceVolumes(member)/memberEnv(member) likewise consume the blob member's already-resolved
    // mount/territory/repo — so no security field is ever read from the member-writable roster.
    sessionId: memberSessionId(member.org, member.handle),
    persona,
  }
}

export { loadRoster }
