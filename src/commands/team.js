// `mrc team` — assemble and launch a team of agent members from a roster (team.json).
//
//   mrc team up      [path] [--roster f]   load roster, push it to the daemon, launch live members
//   mrc team status  [path]                show the org, rooms, and @user inbox
//   mrc team console <handle> [path]       attach to a running member's terminal (tmux)
//   mrc team down    [path]                close the org's rooms (containers are left to exit)
//   mrc team define  [path]                push the roster to the daemon WITHOUT launching
//
// Live (Claude) members each run as their own `mrc <repo> --member <handle>` session in a tmux
// window. Worker (non-Claude) members are declared in the org but invoked on demand (P5), so `up`
// does not spawn a container for them.
import net from 'node:net'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { memberSessionId } from '../teams/session-id.js'
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
import { loadLaunches, saveLaunch, setMemberLaunch, removeMemberLaunch } from '../rooms.js'

const MRC_JS = fileURLToPath(new URL('../../mrc.js', import.meta.url))
const daemonMetaPath = () => join(homedir(), '.local', 'share', 'mrc', 'room-daemon.json')
const readMeta = () => { try { return JSON.parse(readFileSync(daemonMetaPath(), 'utf8')) } catch { return null } }
const tmuxSession = (org) => `mrc-${String(org).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

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
  return buildPersona({ self, team: member.team, roster, isLead: member.lead, territory: member.territory, mount: member.mount, role: member.role })
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

function hasTmux() {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false }
}

// Is a recorded process still alive? (signal 0 = existence check; EPERM still means it exists.)
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
// A member session is alive only if its dtach master pid is alive AND its socket still exists — the
// pid alone is unsafe across a daemon restart (the OS can recycle it onto an unrelated process); the
// socket is the session artifact, so requiring both avoids reporting a dead member as up (Roland #2).
const sessionAlive = (info) => !!(info && pidAlive(info.dtachPid) && info.sock && existsSync(info.sock))
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
  try { unlinkSync(sock) } catch {}   // clear any stale socket from a dead prior session
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
    if (sessionAlive(prev)) { members[m.handle] = prev; continue }   // session still up — keep it
    already = false
    const port = await findFreePort(nextPort); nextPort = port + 1
    members[m.handle] = spawnMemberSession(norm.org, m.handle, port, memberShellCmd(repoPath, m, rosterPath))
  }
  return { members, already }
}

// --- launch lifecycle (shared by `mrc team up` and the daemon's GUI launch) ----------------------
export function hasTtyd() { try { execFileSync('ttyd', ['--version'], { stdio: 'ignore' }); return true } catch { return false } }
// dtach has NO version flag: any invocation that isn't a real session prints usage and exits non-zero.
// So presence ≠ exit-zero — we only treat ENOENT (binary not on PATH) as missing; a non-zero exit means
// dtach IS installed (it just rejected our probe args).
export function hasDtach() { try { execFileSync('dtach', ['-V'], { stdio: 'ignore' }); return true } catch (err) { return err?.code !== 'ENOENT' } }
// (legacy tmux helpers kept only for the `mrc team console` attach path until chunk C replaces it.)
export function tmuxSessionExists(session) { return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0 }

// #34: the set of a team's members whose SESSION is alive (the dtach master — NOT the ephemeral ttyd
// viewer). Keyed by HANDLE; drives the daemon's launched-vs-online reconcile. A member is "launched"
// while its dtach master lives, regardless of whether any browser is attached.
export function launchedMemberHandles(org) {
  const mems = (loadLaunches()[org] || {}).members || {}
  const s = new Set()
  for (const [h, info] of Object.entries(mems)) if (sessionAlive(info)) s.add(h)
  return s
}
// Per-member terminal view for the dashboard: handle -> { ttydPort, ttydUrl, alive }. `alive` = the
// dtach session (master), not the ttyd viewer (which comes and goes as you open/close the console).
export function memberTtyds(org) {
  const mems = (loadLaunches()[org] || {}).members || {}
  const out = {}
  for (const [h, info] of Object.entries(mems)) out[h] = { ttydPort: info.ttydPort, ttydUrl: info.ttydPort ? `http://127.0.0.1:${info.ttydPort}/` : null, alive: sessionAlive(info) }
  return out
}
// Stop a team. Order matters (Roland #5): kill the ttyd VIEWER → kill the dtach MASTER → `docker kill`
// the member CONTAINER (the load-bearing stop — the detached container can outlive the master, #1) →
// unlink the socket last (unlinking before the master dies risks an orphaned master/phantom session).
export function killTeamSession(org) {
  const rec = loadLaunches()[org] || {}
  const mems = rec.members || {}
  let any = false
  for (const [handle, info] of Object.entries(mems)) {
    if (info?.ttydPid) { try { process.kill(info.ttydPid, 'SIGTERM') } catch {} }
    if (info?.dtachPid) { try { process.kill(info.dtachPid, 'SIGTERM'); any = true } catch {} }
    dockerKillMember(rec.repo, handle)
    if (info?.sock) { try { unlinkSync(info.sock) } catch {} }
  }
  return any
}

// Build the image once, then launch each live member in its OWN ttyd; persist the per-member registry.
// ttyd is REQUIRED — it's the PTY holder now (no tmux fallback). Returns { ok, members, already, live }.
export async function startTeamSession(norm, repoPath, { rosterPath } = {}) {
  const live = norm.members.filter((m) => m.tier === 'live')
  if (!live.length) return { ok: false, error: 'no live members to launch' }
  if (!hasTtyd()) return { ok: false, error: 'ttyd not found — it now hosts each member terminal (brew install ttyd / apt install ttyd)' }
  if (!hasDtach()) return { ok: false, error: 'dtach not found — it keeps each member session alive across console switches (brew install dtach / apt install dtach)' }
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
  return { org: def?.org, repo: def?.repo, teams: Object.values(teams) }
}

// Remove a member from a roster by handle; drop any team left empty. Returns a copy.
export function removeMemberFromRoster(roster, handle) {
  const r = JSON.parse(JSON.stringify(roster || { teams: [] }))
  const h = String(handle).toLowerCase()
  for (const t of (r.teams || [])) t.members = (t.members || []).filter((m) => makeHandle(m.name, m.backend) !== h)
  r.teams = (r.teams || []).filter((t) => (t.members || []).length)
  return r
}

// Keep the repo's team.json in sync with the live project (written as { project, teams }).
export function writeTeamFile(repo, roster) {
  try { writeFileSync(join(repo, 'team.json'), JSON.stringify({ project: roster.org, teams: roster.teams }, null, 2) + '\n'); return true } catch { return false }
}

// #34: stop one member's session (same order as killTeamSession): ttyd viewer → dtach master →
// `docker kill` the container → unlink socket → drop from the registry. (Removed from a running team.)
export function killMember(org, handle) {
  const rec = loadLaunches()[org] || {}
  const info = (rec.members || {})[handle]
  if (info?.ttydPid) { try { process.kill(info.ttydPid, 'SIGTERM') } catch {} }
  if (info?.dtachPid) { try { process.kill(info.dtachPid, 'SIGTERM') } catch {} }
  dockerKillMember(rec.repo, handle)
  if (info?.sock) { try { unlinkSync(info.sock) } catch {} }
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

  mrc team up      [path] [--roster f | --preset name]   define + launch live members (tmux/ttyd)
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
      if (presetFlag) {
        let roster; try { roster = buildPreset(presetFlag, { org: basename(repoPath) }) } catch (e) { console.error(`  ✗ ${e.message}`); process.exit(1) }
        ;({ norm, rosterPath: path } = materializeRoster(roster, repoPath))
      } else {
        ({ norm, path } = loadRoster(repoPath, rosterFlag))
      }
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
      if (!hasTtyd() || !hasDtach()) {
        const missing = [!hasTtyd() && 'ttyd', !hasDtach() && 'dtach'].filter(Boolean).join(' + ')
        console.log(`  ${missing} not found — ttyd hosts each member terminal and dtach keeps its session alive across`)
        console.log('  console switches. Install (brew install ttyd dtach / apt install ttyd dtach) and relaunch, or run a member directly:')
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
      if (!m) { console.error(`No member "${handle}" in the roster.`); process.exit(1) }
      const session = tmuxSession(norm.org)
      if (spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status !== 0) {
        console.error(`  No running team session for "${norm.org}". Run \`mrc team up\` first.`); process.exit(1)
      }
      spawnSync('tmux', ['select-window', '-t', `${session}:${m.first}`], { stdio: 'ignore' })
      const r = spawnSync('tmux', ['attach', '-t', session], { stdio: 'inherit' })
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
