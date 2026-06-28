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
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseRoster, validateRoster, findRoster } from '../teams/roster.js'
import { buildPersona } from '../teams/personas.js'
import { makeHandle } from '../teams/names.js'
import { PRESETS, listPresets, buildPreset } from '../teams/presets.js'
import { runWorkerExec, volumeName } from '../docker.js'
import { loadEnv, repoEnvKey } from '../config.js'
import { findFreePort } from '../ports.js'
import { loadLaunches, saveLaunch, setMemberLaunch, removeMemberLaunch, removeLaunch } from '../rooms.js'

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
export function memberWorkspaceVolumes(member, repoPath) {
  const vols = []
  if (member.mount === 'rw' && member.territory === '.') {
    vols.push('-v', `${repoPath}:/workspace`)
  } else {
    vols.push('-v', `${repoPath}:/workspace:ro`)
    vols.push('-v', `${join(repoPath, '.mrc')}:/workspace/.mrc`)
    if (member.mount === 'rw' && member.territory !== '.') {
      vols.push('-v', `${join(repoPath, member.territory)}:/workspace/${member.territory}`)
    }
  }
  return vols
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
  const dir = join(repoPath, '.mrc', 'teams')
  mkdirSync(dir, { recursive: true })
  const name = `${personaSlug(member.handle)}.persona`
  writeFileSync(join(dir, name), text)
  return `/workspace/.mrc/teams/${name}`
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
  loadEnv(dirname(MRC_JS))   // populate OPENAI_API_KEY etc. (team dispatch runs before mrc.js loads .env)
  const dir = join(repoPath, '.mrc', 'teams')
  mkdirSync(dir, { recursive: true })
  const name = `${personaSlug(member.handle)}.exec-prompt`
  writeFileSync(join(dir, name), prompt)
  const containerPromptFile = `/workspace/.mrc/teams/${name}`
  const vols = [...memberWorkspaceVolumes(member, repoPath)]
  const volName = volumeName(`${repoPath}#${member.handle}`, 1)
  vols.push('-v', `${volName}:/home/coder/.claude`, '-v', `${volName.replace('mrc-config-', 'mrc-codex-')}:/home/coder/.codex`)
  const env = [
    '-e', `MRC_AGENT=${member.backend}`, '-e', `MRC_MEMBER_HANDLE=${member.handle}`,
    '-e', `MRC_TEAM=${member.team}`, '-e', `MRC_ROLE=${member.role}`,
    '-e', `MRC_EXEC_PROMPT_FILE=${containerPromptFile}`, '-e', 'ALLOW_WEB=1',
  ]
  const openai = repoEnvKey(repoPath, 'OPENAI_API_KEY')   // per-repo .env first, then global
  if (openai) env.push('-e', `OPENAI_API_KEY=${openai}`)
  return cleanWorkerOutput(runWorkerExec({ repoPath, envFlags: env, volumes: vols, allowWeb: true }))
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
  const daemon = await ensureRoomDaemon({ portBase, notifyPort: 0 })
  const r = await controlCall(daemon.controlPort, { action: 'defineOrg', def: orgDef(norm) })
  return { ok: !!r?.ok, controlPort: daemon.controlPort, daemonPort: daemon.port, rooms: r?.rooms || [], error: r?.error }
}

// --- launching -------------------------------------------------------------
function loadRoster(repoPath, rosterPath) {
  const path = rosterPath || findRoster(repoPath)
  if (!path) throw new Error(`no roster found. Create team.json in ${repoPath} (or pass --roster <file>).`)
  const norm = parseRoster(readFileSync(path, 'utf8'), { repo: repoPath })
  return { norm, path }
}

function memberArgv(repoPath, member, rosterPath) {
  return [MRC_JS, repoPath, '--member', member.handle, '--roster', rosterPath]
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
// Stop the actual member: kill its container by the mrc.member (+repo) label. Killing the dtach master
// tears down the terminal/sh but the detached `docker run` container can keep running — so this is the
// LOAD-BEARING member stop, not a backstop (Roland #1).
function dockerKillMember(repo, handle) {
  // Require BOTH labels. Handles are deterministic (first/backend), so two projects can share one (each
  // with an @apolline/claude); matching mrc.member=<handle> alone — if repo were unknown — would kill the
  // OTHER project's same-handled container. Fail SAFE: skip + log rather than a repo-wide kill-by-handle
  // (Roland R-dtach-1). repo is normally set by setMemberLaunch, so this only guards a degraded record.
  if (!repo) { try { console.error(`[#34] dockerKillMember: no repo for @${handle} — skipping (won't risk a cross-project kill-by-handle)`) } catch {}; return }
  try {
    const ids = execFileSync('docker', ['ps', '-q', '--filter', `label=mrc.member=${handle}`, '--filter', `label=mrc.repo=${repo}`], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean)
    for (const id of ids) { try { execFileSync('docker', ['kill', id], { stdio: 'ignore' }) } catch {} }
  } catch {}
}
// #41 detection: the set of member handles whose mrc.member CONTAINER is live — the durable, master-state-
// independent "member up" signal (a container can outlive its master). One `docker ps` per org per poll.
// Requires the repo label so two projects sharing a handle don't cross-count (same fail-safe as the kill).
let _dockerProbeWarned = false
function dockerMemberHandles(repo) {
  if (!repo) return new Set()
  try {
    // `docker ps --format` exposes a label via the `.Label "k"` METHOD; `.Labels` here is a comma-joined
    // STRING (NOT the map it is under `docker inspect`), so `index .Labels "k"` throws "cannot index
    // slice/array with type string" → non-zero exit → (pre-fix) a silently-empty Set → every container
    // reads absent → all terminals blank. Use the ps-correct `.Label` (matches room-daemon.js's scan).
    const out = execFileSync('docker', ['ps', '--filter', 'label=mrc.member', '--filter', `label=mrc.repo=${repo}`, '--format', '{{.Label "mrc.member"}}'], { encoding: 'utf8' })
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
const memberShellCmd = (repoPath, m, rosterPath) =>
  `node ${memberArgv(repoPath, m, rosterPath).map(shq).join(' ')}; echo; echo ${shq(`[@${m.first} exited — press enter]`)}; read`

// dtach sockets (one per member, stable across reconnects) live under the daemon dir.
const socketDir = () => join(homedir(), '.local', 'share', 'mrc', 'sockets')
const sockSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const memberSock = (org, handle) => join(socketDir(), `${sockSlug(org)}-${sockSlug(handle)}.dtach`)

// #34: a member runs inside a persistent `dtach -n` MASTER (holds the session detached so it survives the
// browser disconnecting / a console switch / the dashboard closing — what tmux used to do), with a thin
// ttyd VIEWER (`dtach -a`) that attaches on connect and RE-ATTACHES the same session on reconnect (no
// restart). dtach is a transparent byte relay, so ttyd's real xterm-256color + the native mouse-wheel
// scroll pass straight through. Returns the registry entry.
function spawnMemberSession(org, handle, port, shellCmd) {
  const sock = memberSock(org, handle)
  mkdirSync(dirname(sock), { recursive: true })
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
  // viewer: ttyd attaches to the dtach session; a reconnect re-attaches the SAME session.
  const ttyd = spawn('ttyd', ['-W', '-i', '127.0.0.1', '-p', String(port), 'dtach', '-a', sock, '-E', '-r', 'winch'], { detached: true, stdio: 'ignore', env })
  ttyd.unref()
  return { sock, dtachPid: master.pid, ttydPort: port, ttydPid: ttyd.pid, containerId: null }
}

// #34: launch each live member as its own persistent dtach session + ttyd viewer. Reuses a member's
// existing session if its dtach master is still alive (idempotent relaunch). Returns the registry map.
async function launchMembers(norm, repoPath, rosterPath, live) {
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
      members[m.handle] = spawnMemberSession(norm.org, m.handle, port, memberShellCmd(repoPath, m, rosterPath))
    } catch (e) {
      // The unlink-guard throw (or any spawn failure) must fail LOUD-but-CONTAINED: log + flag this one
      // member, never abort the whole team launch or crash the daemon's launch subprocess (#28 backstop
      // is last-resort; this is the explicit boundary catch).
      console.error(`  ⚠ @${m.handle} not launched: ${e?.message || e}`)
      members[m.handle] = { ...(prev || {}), sock: memberSock(norm.org, m.handle), orphaned: true }
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
  const liveContainers = dockerMemberHandles(repo)
  const out = {}
  for (const [h, info] of Object.entries(mems)) {
    const state = classifyTerminal(info, { containerAlive: liveContainers.has(h), online: onlineHandles?.has(h), withinGrace })
    out[h] = { ttydPort: info.ttydPort, ttydUrl: info.ttydPort ? `http://127.0.0.1:${info.ttydPort}/` : null, state }
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
    dockerKillMember(rec.repo, handle)
    try { unlinkSync(sock) } catch {}
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
export async function startTeamSession(norm, repoPath, { rosterPath } = {}) {
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
  const { members, already } = await launchMembers(norm, repoPath, rosterPath, live)
  saveLaunch(norm.org, { repo: repoPath, members })
  return { ok: true, members, already, live: live.map((m) => ({ handle: m.handle, first: m.first, role: m.role })) }
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
    teams[m.team].members.push(mm)
  }
  const roster = { org: def?.org, repo: def?.repo, teams: Object.values(teams) }
  // #43: carry the custom `personas` block so a REBUILT roster keeps custom-role charters. The in-memory
  // def doesn't store personas; team.json on disk is their authoritative home (kept intact by #51). Without
  // this, every addmember / removemember / launch-reconstruction re-parses a roster with no personas, so a
  // custom-role member (added live OR relaunched) resolves the generic fallback — no label, no mandate.
  try {
    if (def?.repo) {
      const tj = JSON.parse(readFileSync(join(def.repo, 'team.json'), 'utf8'))
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
  const rec = loadLaunches()[org] || {}
  const sock = memberSock(org, handle)
  killHostPlumbingForSock(sock)
  dockerKillMember(rec.repo, handle)
  try { unlinkSync(sock) } catch {}
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
  team.members.push(m)
  return r
}

// #34: launch ONE member into an already-running org as its own dtach session + ttyd viewer (image
// already built — safe from the daemon). No-op if the team isn't launched or the member's session is up.
export async function launchMember(org, repoPath, rosterPath, member) {
  const rec = loadLaunches()[org]
  if (!rec) return { ok: false, error: 'team not launched' }
  const prev = (rec.members || {})[member.handle]
  if (sessionAlive(prev)) return { ok: true, already: true }
  // #41: never spawn over a live master (orphans it). If one's alive but unservable, it's orphaned —
  // recovery is a Relaunch that kills it first (relaunchMember), not a bare re-spawn here.
  if (masterAliveForSock(memberSock(org, member.handle))) return { ok: false, error: 'session orphaned — use Relaunch (stops the live master first) to restore the terminal', orphaned: true }
  try {
    const port = await findFreePort(Number(process.env.MRC_TTYD_PORT) || 7681)
    setMemberLaunch(org, member.handle, spawnMemberSession(org, member.handle, port, memberShellCmd(repoPath, member, rosterPath)))
    return { ok: true }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

// Parse a roster (object or JSON string), write it to <repo>/.mrc/team.runtime.json so launched
// members can --roster it, and return { norm, rosterPath }. Used by the daemon's GUI launch.
export function materializeRoster(rosterInput, repoHint) {
  const norm = parseRoster(rosterInput, { repo: repoHint })
  const dir = join(norm.repo, '.mrc'); mkdirSync(dir, { recursive: true })
  const rosterPath = join(dir, 'team.runtime.json')
  writeFileSync(rosterPath, typeof rosterInput === 'string' ? rosterInput : JSON.stringify(rosterInput, null, 2))
  return { norm, rosterPath }
}

export async function teamCommand(argv) {
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
      const file = join(repoPath, 'team.json')
      if (existsSync(file)) { console.error(`  ✗ ${file} already exists — edit it, or delete it first.`); process.exit(1) }
      mkdirSync(repoPath, { recursive: true }); writeFileSync(file, JSON.stringify(roster, null, 2) + '\n')
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
        for (const m of live) console.log(`      node ${memberArgv(repoPath, m, path).join(' ')}`)
        return
      }
      const r = await startTeamSession(norm, repoPath, { rosterPath: path })
      if (!r.ok) { console.error(`  ✗ ${r.error}`); process.exit(1) }
      console.log(r.already
        ? '  ◎ team already running — its member terminals are up:'
        : `  ◎ Launched ${live.length} member(s), each in its own ttyd terminal:`)
      for (const m of live) {
        const port = r.members?.[m.handle]?.ttydPort
        const url = port ? `http://127.0.0.1:${port}/` : '(no terminal)'
        console.log(`      @${m.first}/${m.backend}  (${m.roleLabel}${m.lead ? ', lead' : ''}, ${m.team})  →  ${url}`)
      }
      console.log('\n  Each member terminal is embedded in the dashboard Console (mrc rooms dashboard).')
      console.log('  Each member accepts the one-time Channels prompt on first launch.')
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
      const { norm } = loadRoster(repo, rosterFlag)
      const member = norm.members.find((m) => m.handle === handle.toLowerCase() || m.first.toLowerCase() === handle.toLowerCase())
      if (!member) { console.error(`No member "${handle}" in the roster.`); process.exit(1) }
      let prompt = sub === 'exec' ? rest.slice(1).filter((a) => !a.startsWith('--')).join(' ') : ''
      if (!prompt) prompt = await readStdin()
      if (!prompt.trim()) { console.error('No prompt (positional arg or stdin).'); process.exit(1) }
      process.stdout.write(await execWorker(norm, member, repo, prompt))
      return
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

    default:
      console.error(`Unknown team command: ${sub}. Try: mrc team help`)
      process.exit(1)
  }
}

// Build the launch wiring for a single member (called from mrc.js when --member is set). Returns
// { envFlags, volumes, sessionId, persona } — pure given the roster/member; writes the persona file.
export function memberLaunch(norm, member, repoPath) {
  const persona = personaForMember(norm, member)
  const personaPath = writePersonaFile(repoPath, member, persona)
  return {
    envFlags: memberEnv(member, personaPath),
    workspaceVolumes: memberWorkspaceVolumes(member, repoPath),
    sessionId: memberSessionId(norm.org, member.handle),
    persona,
  }
}

export { loadRoster }
