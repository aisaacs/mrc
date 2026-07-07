#!/usr/bin/env node
//
// mrc.js — Mister Claude
// Launch Claude Code in a sandboxed Docker container with network firewall.
//
import { resolve, basename, dirname } from 'node:path'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BANNER } from './src/constants.js'
import { setVerbose, dbg } from './src/output.js'
import { readMrcrc, loadEnv, parseArgs, sanitizeRepoConfig } from './src/config.js'
import { ensureDocker } from './src/colima.js'
import { buildImage, checkImageAge, getExistingCount, volumeName, nextAdversarySlot, nextInstanceSlot, runContainer, startDaemon, showStatus, imageIdAndLabels, sliceLiveContainer, heldUuids } from './src/docker.js'
import { resolveStoreMode, storeCtx, mrcStoreDir, sessionStoreDir, migrateAndNormalize } from './src/mrc-store.js'   // #5 store-mode (memory out of repo → /mrc); inert unless the image is store-capable
import { rosterMemberSessionIds } from './src/commands/team.js'   // #5 PICKABLE⟺MIGRATED: the roster's memberSessionId exclude, shared by the picker + the migration
import { processSandboxignores } from './src/sandboxignore.js'
import { findFreePort } from './src/ports.js'
import { startClipboardProxy } from './src/proxies/clipboard-proxy.js'
import { startNotifyProxy } from './src/proxies/notify-proxy.js'
import { startSniProxy } from './src/proxies/sni-proxy.js'   // A/#40: host SNI-pinning egress proxy for a caged adversary
import { listSessions, nameSession, resolve as resolveSession, loadNames, resolveSessionId, getSessions } from './src/sessions/manager.js'
import { summarize, generateName } from './src/sessions/api.js'
import { pick, ensureNamesMigrated } from './src/sessions/picker.js'
import { makeNamer } from './src/sessions/name-watcher.js'
import { detectToolMisses } from './src/sessions/transcript.js'
import { resolveContextDir } from './src/context.js'
import { saveSessionRecord, pruneSessionRecords, isAdversarySession, loadSessionRecord, classifySession } from './src/session-record.js'
import { randomBytes } from 'node:crypto'   // R1/#44: per-session register secret
import { createInterface } from 'node:readline'   // D10: adversary-resume consent prompt

const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = dirname(__filename)
const CONTEXT_DIR = resolveContextDir(SCRIPT_DIR)

// --- Load config ---
const { flags: globalFlags, envs: globalEnvs } = readMrcrc(resolve(process.env.HOME, '.mrcrc'))

// Sniff repo path for per-repo .mrcrc
let repoHint = process.cwd()
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('-') || arg === '--') continue
  if (['status', 'sessions', 'pick'].includes(arg)) break
  try { if (existsSync(arg)) { repoHint = resolve(arg); break } } catch {}
}
// Belt 0: the repo .mrcrc is sandbox-writable, so allowlist it (deny-by-default) BEFORE the merge — a
// contained session can't smuggle -w/--room/--summoned-by/ALLOW_WEB/MRC_* into its next launch. The global
// ~/.mrcrc (host-owned) is trusted and NOT filtered.
const { flags: rawRepoFlags, envs: rawRepoEnvs } = readMrcrc(resolve(repoHint, '.mrcrc'))
const { flags: repoFlags, envs: repoEnvs } = sanitizeRepoConfig(rawRepoFlags, rawRepoEnvs, (msg) => console.error(`  ⚠ Ignoring ${msg}.`))

// Merge: config flags first, then CLI args (CLI overrides)
const configEnvs = [...globalEnvs, ...repoEnvs]
const allArgs = [...globalFlags, ...repoFlags, ...process.argv.slice(2)]
const { config, remaining, claudeArgs, help } = parseArgs(allArgs)

if (help) {
  if (remaining?.[0] === 'rooms' || remaining?.[0] === 'room') {
    const { roomsCommand } = await import('./src/commands/rooms.js')
    await roomsCommand(['help'])
    process.exit(0)
  }
  console.log(`Usage: mrc [options] [path-to-repo] [-- claude-code-args...]

Options:
  -r, --rebuild        Force a full image rebuild (no cache)
  -v, --verbose        Show Colima and Docker output (useful for debugging)
  --daemon             Start container in background and print container ID
  -j, --json           Stream JSON output instead of interactive TTY (for embedding)
  -n, --new [name]     Start a new conversation (optionally named)
  -w, --web            Allow outbound HTTPS to any host (for web search/fetch)
  --agent <name>       AI agent to launch: claude (default), codex
  --solo               Run as a team-of-one in the dashboard (browser console + @user inbox;
                       browser + native terminal attach to one session), no team.json needed
  --room <name>        Pair only with another session that shares this --room name
  --no-rooms           Disable cross-session negotiation rooms for this session
  --no-summary         Skip AI session summary on exit
  --no-notify          Disable desktop notifications on response complete
  --no-sound           Disable notification sound (still shows notification)
  --colima-cpu N       CPUs for Colima VM (default: all host cores)
  --colima-memory N    Memory (GB) for Colima VM (default: half host RAM, min 8)

Commands:
  mrc gui [path]                          Open the standalone GUI: build, launch & control a team
  mrc status                              Show active containers across repos
  mrc pick [path]                         Interactive session picker (arrow keys)
  mrc rooms [...]                         Watch/steer negotiation rooms (mrc rooms --help)
  mrc team [...]                          Assemble/launch a team of agents (mrc team help)

Session management:
  mrc sessions ls [path]                  List saved sessions
  mrc sessions name <name> [#] [path]     Name a session (default: most recent)
  mrc sessions resume <name-or-#> [path]  Resume a specific session
  mrc sessions pick [path]                Interactive session picker (alias for mrc pick)

Examples:
  mrc ~/projects/myapp
  mrc ~/projects/myapp -- --model claude-sonnet-4-5-20250929
  mrc --agent codex .                     # Use Codex instead of Claude
  mrc .                -- -p "fix the failing tests"
  mrc -v ~/projects/myapp

Hidden paths:
  Create .sandboxignore files anywhere in your repo tree listing paths
  to hide from the container (one per line, relative to the directory
  containing the .sandboxignore file — works like .gitignore):

    .env
    secrets/
    infrastructure/

Config files (one flag per line, comments with #):
  ~/.mrcrc              Global defaults
  <repo>/.mrcrc         Per-repo overrides (merged on top of global)
  CLI flags always take precedence over config files.

Environment:
  MRC_SESSION_NAMING_ANTHROPIC_API_KEY — host-only key for Haiku session
                       naming/summaries (.env next to this script). NOT used by the
                       sandboxed session (it runs on Max/OAuth).
  OPENAI_API_KEY     — loaded from .env (required for --agent codex)
  MRC_PORT_BASE      — starting port for proxy allocation (default: 7722)`)
  process.exit(0)
}

setVerbose(config.verbose)

if (!['claude', 'codex'].includes(config.agent)) {
  console.error(`Unknown agent: ${config.agent}. Available: claude, codex`)
  process.exit(1)
}

// --- Subcommand: mrc status (runs without API key) ---
if (remaining[0] === 'status') {
  showStatus()
  process.exit(0)
}

// --- Subcommand: mrc rooms (observe/steer ambient pairings via the daemon; no API key) ---
if (remaining[0] === 'rooms' || remaining[0] === 'room') {
  const { roomsCommand } = await import('./src/commands/rooms.js')
  await roomsCommand(remaining.slice(1))
  process.exit(0)
}

// --- Subcommand: mrc team (assemble/launch a team of agents from a roster; no API key) ---
if (remaining[0] === 'team') {
  const { teamCommand } = await import('./src/commands/team.js')
  await teamCommand(remaining.slice(1))
  process.exit(0)
}

// --- Subcommand: mrc gui [repo] — the standalone GUI. Boots the daemon + opens the dashboard scoped
// to a repo, ready to build & launch a team. No API key, no other setup. ---
if (remaining[0] === 'gui' || remaining[0] === 'studio') {
  const repo = resolve(remaining[1] || '.')
  const { ensureRoomDaemon } = await import('./src/commands/pair.js')
  const { openBrowser } = await import('./src/rooms-dashboard.js')
  const metaPath = resolve(process.env.HOME, '.local/share/mrc/room-daemon.json')
  const readMeta = () => { try { return JSON.parse(readFileSync(metaPath, 'utf8')) } catch { return null } }
  process.stdout.write('  🎩 Starting Mister Claude…')
  try { await ensureRoomDaemon({ relayPort: Number(process.env.MRC_PORT_BASE) || 7722, notifyPort: 0 }) } catch {}   // #50: relay = the fixed portBase constant
  let dp = readMeta()?.dashboardPort
  for (let i = 0; !dp && i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); dp = readMeta()?.dashboardPort }
  if (!dp) { console.error('\n  ! the daemon is not serving a dashboard (MRC_DASHBOARD_PORT=0?).'); process.exit(1) }
  const url = `http://127.0.0.1:${dp}/${encodeURIComponent(basename(repo))}?repo=${encodeURIComponent(repo)}`
  console.log(` ready.\n  ◎ ${url}\n    Build → pick a preset → 🚀 Launch. The dashboard stays up while it's open.`)
  openBrowser(url)
  process.exit(0)
}

// --- Load .env / API keys ---
// MRC_SESSION_NAMING_ANTHROPIC_API_KEY is host-only (Haiku naming/summaries). Legacy
// ANTHROPIC_API_KEY still works as a deprecated fallback (it collides with the key Claude Code
// auto-detects). Neither is ever injected into the container — the session runs on Max/OAuth.
loadEnv(SCRIPT_DIR, { skipOp: !!config.summonedBy })   // a summoned adversary needs no naming key — skip op:// (no Touch ID / hang)
const apiKey = process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || ''
const legacyKeyVar = !process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY && !!process.env.ANTHROPIC_API_KEY
const openaiKey = process.env.OPENAI_API_KEY || ''
dbg(`Naming key: ${apiKey ? `set (${apiKey.length} chars)${legacyKeyVar ? ' [legacy ANTHROPIC_API_KEY]' : ''}` : 'NOT SET'}`)
dbg(`OpenAI key: ${openaiKey ? `set (${openaiKey.length} chars)` : 'NOT SET'}`)

// #5: session-store routing for a PRE-build read (a subcommand or the auto-resume guard — they run BEFORE the image
// build, so they inspect the EXISTING image; the LAUNCH re-decides from the post-build pinned image and migration
// bridges the activation edge). Plain/user ctx (a subcommand/auto-resume is never a member/adversary). Returns
// { dir, exclude }: dir = the migrated repoId slice (store-mode) or repo/.mrc (legacy); exclude = the roster's
// memberSessionId set (PICKABLE⟺MIGRATED — the picker shows ONLY sessions the launch can resolve).
// #5 (Pierre): the liveness probe is a SYNCHRONOUS docker call that can block a couple seconds on a loaded Colima,
// and a bare launch hits it ~twice — a silent multi-second stall reads as a hang (the exact thing we spent this
// session chasing). Show a transient TTY note during the block, then clear the line. Non-TTY (daemon/json) skips it.
function probeSliceLive(slice) {
  const tty = process.stderr.isTTY
  const msg = '  ⏳ checking the memory store…'
  if (tty) { try { process.stderr.write(msg) } catch {} }
  const r = sliceLiveContainer(slice)
  if (tty) { try { process.stderr.write('\r' + ' '.repeat(msg.length) + '\r') } catch {} }
  return r
}

// #5 per-UUID: the set of session uuids held by live containers (transient TTY note, same as probeSliceLive).
function probeHeldUuids() {
  const tty = process.stderr.isTTY
  const msg = '  ⏳ checking for other sessions…'
  if (tty) { try { process.stderr.write(msg) } catch {} }
  const r = heldUuids()
  if (tty) { try { process.stderr.write('\r' + ' '.repeat(msg.length) + '\r') } catch {} }
  return r
}

function preBuildSessionStore(repoPath) {
  const { id, labels } = imageIdAndLabels()
  const storeMode = resolveStoreMode(id, () => labels).storeMode
  // exclude ONLY in store-mode → the LEGACY picker/resume stays byte-identical to today (the whole relocation is
  // inert until a rebuilt image flips the capability). In store-mode the SAME set feeds the migration (PICKABLE⟺MIGRATED).
  const exclude = storeMode ? rosterMemberSessionIds(repoPath) : null
  // #5 Finding-1: a subcommand (pick/ls/name/resume) is READ-ONLY — it must not mtime-rewrite a slice a live
  // container is using. Inject the ceiling probe so migrateAndNormalize skips the normalize WRITE when the slice is
  // live or unverifiable (still migrates copy-if-absent, still lists — the repair defers to a later idle launch).
  const isLive = (slice) => { const p = probeSliceLive(slice); return !!(p.id || !p.determined) }
  const dir = sessionStoreDir({ storeMode, ctx: { isMember: false, isSolo: false, adversary: false, repoPath }, legacyDir: resolve(repoPath, '.mrc'), migrate: true, exclude, isLive })
  return { dir, exclude }
}

// --- Subcommand: mrc pick ---
if (remaining[0] === 'pick') {
  const repoPath = resolve(remaining[1] || '.')
  const { dir: mrcDir, exclude } = preBuildSessionStore(repoPath)
  const result = await pick(mrcDir, { exclude, repoPath })   // #5: repoPath (required) so store-mode surfaces adversary rows (mrcDir is the slice, not the repo)
  if (!result) process.exit(0)
  config.allowWeb = true
  if (result === 'NEW') {
    config.newSession = true
  } else {
    config.resumeSession = result
  }
  remaining.length = 0
}

// D10: reconnecting to a summoned adversary (Pierre) is a legitimate, deliberate act (crash / restart /
// keep-context) — but never an accident, so we confirm on the non-picker `sessions resume` path. The
// resume-recage at mrc.js already re-applies the cage; this adds the consent gate in front of it. A
// non-TTY caller can't answer, so it fails safe (NO). (The picker's own TUI confirm is D2, tracked.)
async function askYesNo(q) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try { return /^y(es)?$/i.test((await new Promise((r) => rl.question(`${q} [y/N] `, r))).trim()) }
  finally { rl.close() }
}
async function confirmIfAdversary(mrcDir, uuid) {
  if (!isAdversarySession(uuid)) return true
  const rec = loadSessionRecord(uuid) || {}
  const issuer = loadNames(mrcDir)[rec.summonedBy] || (rec.summonedBy || '').slice(0, 8) || 'a prior session'
  const self = loadNames(mrcDir)[uuid] || 'this session'
  return askYesNo(`  ⚔  "${self}" is a RED-TEAM (adversary) session you summoned for "${issuer}". Reopen it?`)
}

// --- Subcommand: mrc sessions ---
if (remaining[0] === 'sessions') {
  const subcmd = remaining[1] || 'ls'
  const sessionsArgs = remaining.slice(2)

  switch (subcmd) {
    case 'ls': {
      const repoPath = resolve(sessionsArgs[0] || '.')
      const { dir, exclude } = preBuildSessionStore(repoPath)
      await ensureNamesMigrated(dir)
      listSessions(dir, { exclude })
      process.exit(0)
    }
    case 'name': {
      const name = sessionsArgs[0]
      const num = sessionsArgs[1] || '1'
      const repoPath = resolve(sessionsArgs[2] || '.')
      if (!name) { console.error('Usage: mrc sessions name <name> [#] [path]'); process.exit(1) }
      const { dir, exclude } = preBuildSessionStore(repoPath)
      nameSession(dir, name, num, { exclude, repoPath })   // #5: repoPath required (store-mode)
      process.exit(0)
    }
    case 'resume': {
      const query = sessionsArgs[0]
      const repoPath = resolve(sessionsArgs[1] || '.')
      if (!query) { console.error('Usage: mrc sessions resume <name-or-#> [path]'); process.exit(1) }
      const { dir, exclude } = preBuildSessionStore(repoPath)
      const uuid = resolveSession(dir, query, { exclude, repoPath })   // #5: repoPath required (store-mode)
      if (!uuid) { console.error(`Session not found: ${query}`); process.exit(1) }
      if (!(await confirmIfAdversary(dir, uuid))) {   // D10: adversary resume is deliberate on every path, not just the picker
        // Print WHY before exiting — a bare exit(0) reads as success to automation. Distinguish "human said no"
        // from "non-TTY couldn't ask" (askYesNo fails safe to NO on a non-TTY, so a scripted resume silently did nothing).
        console.error(process.stdin.isTTY
          ? '  Adversary (red-team) resume not confirmed — aborting.'
          : '  Refusing to resume a red-team (adversary) session non-interactively — rerun in a TTY to confirm, or pass --open-adversary-unsafe deliberately.')
        process.exit(0)
      }
      config.resumeSession = uuid
      remaining.length = 0
      break
    }
    case 'pick': {
      const repoPath = resolve(sessionsArgs[0] || '.')
      const { dir, exclude } = preBuildSessionStore(repoPath)
      const result = await pick(dir, { exclude, repoPath })   // #5: repoPath required (store-mode)
      if (!result) process.exit(0)
      config.allowWeb = true
      if (result === 'NEW') config.newSession = true
      else config.resumeSession = result
      remaining.length = 0
      break
    }
    default:
      console.error(`Unknown sessions command: ${subcmd}`)
      process.exit(1)
  }
}

// --- Validate API key for selected agent ---
if (config.agent === 'codex' && !openaiKey) {
  console.log(`
  ⚠ The Schwartz needs an OpenAI key for Codex!

  "I can't fire this thing without the combination!"
     — Colonel Sandurz, probably

  Add OPENAI_API_KEY to your .env file:
    ${SCRIPT_DIR}/.env

    OPENAI_API_KEY="sk-..."

  Or with 1Password:
    OPENAI_API_KEY="op://Vault/OpenAI API key/credential"
`)
  process.exit(1)
}

if (config.agent === 'claude' && !apiKey && !config.summonedBy) {   // a summoned Pierre is named deterministically → no host naming key needed, don't exit
  console.log(`
  ⚠ The Schwartz is not with you... no session-naming key found!

  "I can't make it work without the combination!"
     — Colonel Sandurz, probably talking about this .env file

  mrc needs an Anthropic API key for session naming and summaries — cheap Haiku
  calls made on the HOST. This is NOT your Claude Code subscription: the sandboxed
  session runs on your Max/OAuth login, and this key never enters the container.

  Upgrading? This key was renamed — ANTHROPIC_API_KEY is now
  MRC_SESSION_NAMING_ANTHROPIC_API_KEY (so it can't collide with the key Claude
  Code auto-detects). Rename it in your .env.

  To unlock Druidia's fresh air supply, add one line to your .env
  (${SCRIPT_DIR}/.env or ~/.config/mrc/.env):

    MRC_SESSION_NAMING_ANTHROPIC_API_KEY="sk-ant-..."
    # ...or via 1Password:
    MRC_SESSION_NAMING_ANTHROPIC_API_KEY="op://Engineering/MRC Claude API key/credential"

  May the Schwartz be with you!
`)
  process.exit(1)
}

// Nudge anyone still on the legacy variable name (only when a key WAS found via the old name).
if (config.agent === 'claude' && legacyKeyVar) {
  console.log('\x1b[0;33m  ⚠ mrc is reading the legacy ANTHROPIC_API_KEY for session naming.\x1b[0m')
  console.log('\x1b[0;2m    Rename it to MRC_SESSION_NAMING_ANTHROPIC_API_KEY in your .env (legacy works for now).\x1b[0m')
}

// --- Main launch flow ---
const repoPath = resolve(remaining[0] || '.')

// #49: solo onramp — born-detachable OUTER launcher. `mrc <repo> --solo` (no --member) spawns the solo
// session inside a dtach master + ttyd (browser console + native terminal both attach to ONE session) and
// attaches your terminal; the INNER `--solo --member you/claude` (run inside the master) self-derives and
// runs the container. Placed BEFORE ensureDocker + the exit-cleanup hook, and it EXITS on the dtach path,
// so a detach-and-exit here can never stop Colima out from under the still-running inner container. When
// ttyd/dtach are absent it falls back to a plain FOREGROUND solo member (native terminal only).
if (config.solo && !config.member) {
  const { startSoloSession } = await import('./src/commands/team.js')
  const { SOLO_HANDLE } = await import('./src/teams/solo.js')
  const solo = await startSoloSession(repoPath)
  if (solo.fallback) {
    config.member = SOLO_HANDLE   // no ttyd/dtach → run foreground (native only); fall through to the member block
  } else if (!solo.ok) {
    console.error(`  ✗ ${solo.error}`); process.exit(1)
  } else {
    console.log(`  ◎ Solo session live${solo.already ? ' (already running)' : ''}.`)
    console.log(`     Browser console: http://127.0.0.1:${solo.ttydPort}/  (also in \`mrc rooms dashboard\`).`)
    console.log('     Attaching your terminal — detach with Ctrl-\\ (the session keeps running).')
    const r = spawnSync('dtach', ['-a', solo.sock, '-r', 'winch'], { stdio: 'inherit' })
    // Mirror the --daemon branch (Pierre seam-a): drop the exit/signal cleanup listeners before exiting so
    // this thin outer can NEVER stop Colima or close a proxy out from under the still-running inner session.
    process.removeAllListeners('exit'); process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM')
    process.exit(r.status || 0)
  }
}

// --- Team-member mode: this session IS @member from the roster (launched by `mrc team up`) ---
// #49: a --solo session self-derives its team-of-one (soloRoster) instead of loading a team.json, and
// ALWAYS binds the reserved solo member — so an injected --member (e.g. from a repo .mrcrc) can never
// coerce a non-solo member under solo derivation.
let memberCtx = null
if (config.member) {
  const { memberLaunch, resolveMemberNorm, resolveMemberIdentity } = await import('./src/commands/team.js')
  // Selection is a pure, tested function (resolveMemberNorm): solo ⇒ soloRoster + handle forced to
  // SOLO_HANDLE, never reading team.json; non-solo ⇒ loadRoster. Keeping it out of this inline branch is
  // what makes the coercion-resistance a test assertion instead of "trust this branch order forever".
  const { norm, handle, rosterPath } = resolveMemberNorm(config, repoPath)
  config.member = handle
  // #49-SEC (member-writable-roster confused deputy): the inner --member launch derives EVERY security-load-bearing
  // field (org→sessionId, mount/territory→write-scope, repo, cage) from resolveMemberIdentity — the host-set
  // --member-def blob for a team member (immune to a re-tampered on-disk roster), or the repo-derived soloRoster
  // org for solo — and NEVER from `norm` (parsed from the member-writable team.runtime.json). A missing/malformed
  // blob THROWS → fail CLOSED (refuse), never falls through to the roster. `norm` survives ONLY as display context
  // for personaForMember's teammate list (non-load-bearing: rooms bind via the daemon's authoritative sessionIndex;
  // the persona is the member's own untrusted prompt).
  let member
  try { member = resolveMemberIdentity(config, norm, handle) }
  catch (e) { console.error(`  ✗ Refusing to launch: ${e?.message || e}.`); process.exit(1) }
  if (!member) { console.error(`  ✗ No member "${config.member}" in the roster${rosterPath ? ` (${rosterPath})` : ''}.`); process.exit(1) }
  if (member.tier !== 'live') { console.error(`  ✗ @${member.handle} is a ${member.backend} worker — workers are invoked on demand, not launched as a session.`); process.exit(1) }
  const launch = memberLaunch(norm, member, repoPath)
  memberCtx = { norm, member, org: member.org, rosterPath, ...launch }
  config.rooms = true   // a member is always a room participant
  // #5: the member resume-vs-fresh decision is DEFERRED to after the post-build store decision (mrcDir@launch),
  // because in store-mode a member's transcript lives in ITS slice, not repo/.mrc — deciding here (pre-build,
  // raw repo/.mrc) would tell a store-mode member to start fresh even when its slice holds the transcript. The
  // plain/adversary auto-resume guard below is gated on !memberCtx so this deferral can't let it misfire.
}

// Ensure Docker / Colima
const startedColima = await ensureDocker(config.verbose, { colimaCpu: config.colimaCpu, colimaMemory: config.colimaMemory })

// Cleanup on exit
let clipboardServer = null
let notifyServer = null
let sniProxyServer = null
let roomBroker = null

function cleanup() {
  if (clipboardServer) { clipboardServer.close(); clipboardServer = null }
  if (notifyServer) { notifyServer.close(); notifyServer = null }
  if (sniProxyServer) { try { sniProxyServer.close() } catch {} ; sniProxyServer = null }
  if (roomBroker) { try { roomBroker.stop() } catch {} ; roomBroker = null }
  if (startedColima) {
    // Colima is a single shared VM hosting every mrc container. Only stop it
    // if no other mrc sessions are still running — otherwise we'd kill them.
    let others = ''
    try {
      others = execFileSync('docker', ['ps', '--filter', 'label=mrc=1', '--format', '{{.ID}}'], { encoding: 'utf8' }).trim()
    } catch {}
    if (!others) {
      console.log('\n🎩 Goodbye, Lone Starr.')
      try { execFileSync('colima', ['stop'], { stdio: 'ignore' }) } catch {}
    } else {
      console.log('\n🎩 Leaving the ship running — other Mr. Claude sessions are still aboard.')
    }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

// Rooms are ON by default for interactive Claude sessions (--no-rooms to disable). They need an
// interactive TTY — to accept the channel prompt and drive the relay — so they're skipped for
// --daemon, --json, and codex. --room <name> additionally requests explicit same-name pairing.
const roomsEligible = config.agent === 'claude' && !config.daemon && !config.json
if (config.room && !roomsEligible) {
  console.error('  ✗ --room <name> is interactive-only (not with --daemon, --json, or --agent codex).')
  process.exit(1)
}
const roomsActive = roomsEligible && (config.room || config.rooms)

// D1/#25: silent auto-resume guard. A bare `mrc <repo>` auto-`--continue`s the NEWEST session; if that's a
// recorded ADVERSARY (a summoned Pierre — every summon writes an adversary record), NEVER resume it silently
// uncaged. An 'unknown' (pre-record legacy) session can't be a current adversary (a summon needs the daemon +
// writes a record), so it still auto-continues. Runs before session-id resolution so config.newSession takes
// effect. TTY or not, we start FRESH (safe) and point the human at `mrc pick` to deliberately reconnect.
if (config.agent === 'claude' && !memberCtx && !config.newSession && !config.resumeSession) {   // #5: !memberCtx — a member's resume-vs-fresh is decided at the launch (against its own slice), not here
  try {
    const { dir, exclude } = preBuildSessionStore(repoPath)   // #5: read the newest from the EXISTING image's store (slice or legacy), excluding @member transcripts
    const newest = getSessions(dir, { exclude })[0]
    if (newest && classifySession(newest.uuid) === 'adversary') {
      console.error('  ⚔  Your most recent session here is a red-team (adversary) — not auto-continuing it uncaged. Starting fresh; use `mrc pick` to deliberately reconnect (it re-applies the cage).')
      config.newSession = true
    }
  } catch (e) { dbg(`adversary auto-resume guard skipped: ${e?.message || e}`) }
}

// Boot the room daemon BEFORE the (slow) image build so its "ready" log stays visible during the
// build instead of flashing by right before the container clears the screen. Ports are allocated
// once here and reused by the proxies below.
const portBase = Number(process.env.MRC_PORT_BASE) || 7722
let clipPort = 0
let notifyPort = 0
let roomDaemon = null
if (roomsActive) {
  const { ensureRoomDaemon } = await import('./src/commands/pair.js')
  // #50: reserve portBase ITSELF for the daemon's relay — a fixed, concurrency-independent constant (cages pin
  // it; it's the deterministic fallback when room-daemon.json is unreadable). The per-session proxies scan from
  // portBase+1 so they can never self-squat the relay, and the relay NEVER derives from notifyPort (that
  // derivation WAS the #50 split-brain source: the relay port drifted with per-session clip/notify allocation).
  clipPort = await findFreePort(portBase + 1)
  notifyPort = await findFreePort(clipPort + 1)
  roomDaemon = await ensureRoomDaemon({ relayPort: portBase, notifyPort })
}

// Build image
const uid = process.getuid?.() ?? 1000
const gid = process.getgid?.() ?? 1000
buildImage(CONTEXT_DIR, { rebuild: config.rebuild, verbose: config.verbose, uid, gid })

// #5 store-mode: pin the built image to its immutable ID (so inspect-and-run are the SAME image — Hazard C) and
// decide store-mode from its capability LABEL. DENY-UNLESS-PROVEN: an image without the label (today's image, or a
// stale-labeled one that fails the supported-set) → LEGACY, so this is a pure no-op = today's repo/.mrc behavior
// until a rebuilt image flips it. The slice/mount/routing/migration (2b.2+) all gate on `store.storeMode`.
const { id: pinnedImage, labels: pinnedLabels } = imageIdAndLabels()
const store = resolveStoreMode(pinnedImage, () => pinnedLabels)   // one folded inspect; the id we RUN == the id we DECIDED from (Hazard C)
dbg(`store-mode: ${store.reason}`)
checkImageAge(repoPath)

// Resume-recage: explicitly resuming a RECORDED adversary re-applies its cage. --open-adversary-unsafe reopens
// it UNCAGED (full egress) but still daemon-classified (MRC_ADVERSARY). A summon's transcript lives in its own
// config volume and is invisible to the normal picker, so this only fires on a deliberate `--resume <adv-id>`.
if (config.resumeSession && isAdversarySession(config.resumeSession)) {
  config.resumeIsAdversary = true
  if (!config.openAdversaryUnsafe) {
    config.cageAdversary = true
    console.error('  ⚔ Re-sandboxing this adversary session (hardened firewall, no web). Pass --open-adversary-unsafe to open it normally.')
  } else {
    console.error('  ⚠ --open-adversary-unsafe: reopening this adversary session WITHOUT the cage (full egress). Its Pierre volume is reattached.')
  }
}

// A CAGED adversary (a summoned Pierre, or a re-sandboxed resume of one) gets the tightest sandbox: read-only
// /workspace, SNI-pinned egress, no clipboard/notify, a single-room /rooms mount. Everything cage-specific is
// gated on this one flag, so a NORMAL session's launch is byte-identical to before. --open-adversary-unsafe
// leaves cageAdversary unset → it (and only it) stays uncaged (still daemon-classified via MRC_ADVERSARY).
const cagedAdversary = !!(config.summonedBy || config.cageAdversary)
// #11 (coverage-critic): the CONFIG-VOLUME selection keys on adversary IDENTITY, not cage STATE. A recorded adversary
// reopened with --open-adversary-unsafe is uncaged (cagedAdversary=false: rw /workspace + full egress, deliberately)
// but is STILL an adversary — it must reattach its dedicated -pierre-N volume, NEVER the user's real login/config
// volume (the #9 shared-refresh-token / logout hazard the Pierre pool exists to prevent) + its transcript lives there.
// Gating the pool branch on cagedAdversary alone (the re-port bug) dropped the uncaged-resume case into the normal
// nextInstanceSlot branch → mounted mrc-config-<hash> (the login volume) RW into a red-team session. Restore pierre's
// identity gate. (Workspace-ro / egress / clip stay on cagedAdversary — the flag deliberately opens those.)
const adversaryVolume = cagedAdversary || config.resumeIsAdversary

// Volumes. A team member gets territorial mounts (read-only /workspace + its writable lane); a caged
// adversary gets /workspace READ-ONLY; a normal session gets the whole repo read-write.
const volumes = memberCtx ? [...memberCtx.workspaceVolumes] : ['-v', `${repoPath}:/workspace${cagedAdversary ? ':ro' : ''}`]
volumes.push(...processSandboxignores(repoPath))

// Config volume. A member gets its OWN stable volume keyed by handle (each member is its own
// persistent identity); a normal session uses per-repo multi-instance numbering.
let volName
let adversarySlot = 0
if (memberCtx) {
  volName = volumeName(`${repoPath}#${memberCtx.member.handle}`, 1)
} else if (adversaryVolume) {
  // Dedicated per-repo Pierre config-volume pool (mrc-config-<hash>-pierre-N) via a race-free O_EXCL claim, so
  // a summoned adversary NEVER mounts the user's login/config and its transcript can't be auto-resumed by a
  // normal launch (a normal launch uses a different volume, so it never sees the adversary's session). High-
  // water-mark login: log into a slot once, then every future Pierre on it is free + immortal. Fail closed.
  // Login-reuse: a resume PREFERS its own stored slot (claimed through the same race-free gate — a stored slot
  // that's live/claimed just falls through to lowest-free). A fresh summon takes the lowest free slot.
  const preferredSlot = (config.resumeIsAdversary && config.resumeSession) ? (loadSessionRecord(config.resumeSession).slot || 0) : 0
  // Adversary RESUME is EXACT-slot-or-fail: reattach its OWN recorded -pierre-N volume, or abort — NEVER fall back to
  // the lowest-free slot, which would open it inside a DIFFERENT summon's durable volume (its ~/.claude + transcript)
  // = an isolation break (#9) + a silent wrong-identity resume. Summon (resumeIsAdversary=false) stays lowest-free.
  adversarySlot = nextAdversarySlot(repoPath, preferredSlot, { exact: config.resumeIsAdversary })
  if (!adversarySlot) {
    console.error(config.resumeIsAdversary
      ? (preferredSlot
        ? `  ✗ Can't reattach this adversary's dedicated volume — its recorded slot (${preferredSlot}) is held by a running adversary. If THIS adversary is still live, attach to the running session instead of resuming; otherwise close whatever holds slot ${preferredSlot}, then retry (or summon a fresh one). Refusing to reopen it in a DIFFERENT Pierre's volume.`
        : `  ✗ Can't reattach this adversary — no config-volume slot is recorded for it. Summon a fresh one. Refusing to guess a slot and reopen it in a DIFFERENT Pierre's volume.`)
      : '  ✗ Could not safely claim a Pierre slot (docker unreachable, or the slot dir is busy). Nothing launched — try again in a moment.')
    process.exit(1)
  }
  // NB (Pierre): `-pierre-N` is per-SLOT, not per-ADVERSARY. Slots recycle (lowest-free) and the volume is durable
  // (never `docker volume rm`'d), so one `-pierre-N` is shared SEQUENTIALLY across every adversary that held slot N —
  // same ~/.claude/OAuth/settings/projects store. Transcripts stay correct because resume targets the exact
  // `--resume <uuid>.jsonl` (container-setup), and O_EXCL blocks concurrent sharing; both are caged, so it's low-risk.
  // But do NOT assume "`-pierre-N` = one Pierre" — it's "one live claimant at a time," a rolling identity.
  volName = `${volumeName(repoPath, 1)}-pierre-${adversarySlot}`
  console.log(`  ⓘ ${config.resumeIsAdversary ? 'Resuming' : 'Summoned'} adversary on Pierre slot ${adversarySlot} — its own config volume (no clone; it can't log you out).`)
} else {
  // D8: allocate the config-volume slot from the MOUNTED-slot SET oracle (running containers' actual config-volume
  // mounts) + an atomic O_EXCL claim — NOT getExistingCount()+1 (a cardinality that remounted a stopped session's
  // volume: A(1),B(2),stop A,start C → count 1 → C picks 2 = B's live ~/.claude). Nothing running → slot 1 →
  // REUSES mrc-config-<hash> (auto-resume + login persist, per CLAUDE.md). `others` = running peers, for the warning.
  const claim = nextInstanceSlot(repoPath)
  if (!claim) { console.error('  ✗ Could not allocate a config-volume slot (docker unavailable, or 256 sessions running) — refusing to launch rather than risk sharing another session’s ~/.claude.'); process.exit(1) }   // fail closed
  if (claim.others > 0) {
    console.log('')
    console.log(`  ⚠ There's already ${claim.others} Mr. Claude running in this repo.`)
    console.log('    They\'ll share the workspace but get separate config volumes.')
    console.log('    Watch out for edit conflicts — two Claudes, one codebase, no good.')
    console.log('')
    // #5: in STORE-MODE the per-uuid held-check (below) owns the resume decision — a 2nd bare launch CONTINUES its
    // next-most-recent conversation (or fresh if all held), never a same-conversation collision. So DON'T coarsely
    // force-new here (that would pre-empt the held-check → a needless fresh session). LEGACY keeps the force-new
    // (multi-instance shares repo/.mrc, so two --continue would hit one transcript — the old coarse guard).
    if (!config.newSession && !config.resumeSession && !store.storeMode) config.newSession = true
  }
  volName = volumeName(repoPath, claim.slot)
}
volumes.push('-v', `${volName}:/home/coder/.claude`)
if (!adversaryVolume) volumes.push('-v', `${volName.replace('mrc-config-', 'mrc-codex-')}:/home/coder/.codex`)   // an adversary (Pierre) is Claude-only — no codex volume (and never the user's mrc-codex-<hash> — #11: keyed on adversaryVolume so an uncaged resume doesn't mount it either)

// #5 LAUNCH-phase session-store dir. `store` (from the POST-build pinned image) decides. This session's slice comes
// from its FULL ctx: a plain/solo session → its repoId slice, MIGRATED so its repo/.mrc history carries in (and its
// picker excluded @member transcripts identically — PICKABLE⟺MIGRATED); a member/adversary → its own isolated
// slice, migration DEFERRED (old transcripts stay in repo/.mrc, non-destructive/recoverable). Mount it at /mrc; the
// mount-conditional container-setup (2c) retargets the project store there. EVERY launch session-store read routes
// through `mrcDir` — no bypass. Legacy → repo/.mrc unchanged, today's behavior.
// #5: an ADVERSARY stays FULLY LEGACY (its isolated pierre config-vol store + repo/.mrc), NOT store-mode. It's
// already isolated by the pierre vol, so an adv-slice buys no isolation — and the store-mode transition would
// DESTRUCTIVELY drop its un-migrated real-dir transcripts (container-setup's rmSync of a real-dir PROJECT_STORE,
// which the repo/.mrc→slice migration never touches). Defer the adv-slice until it has its own migration. So
// store-mode applies to plain / solo / member only; an adversary keeps today's pierre-vol behavior.
const storeActive = store.storeMode && !cagedAdversary
const storeExclude = storeActive ? rosterMemberSessionIds(repoPath) : null   // store-active only → legacy resolveSessionId is identical to today
const isMemberLaunch = !!memberCtx && config.solo !== true                   // a REAL team member; solo is mechanically a member but keys on repoId + migrates like plain
const launchIsPlainOrSolo = !cagedAdversary && !isMemberLaunch
// #5 migration scope: plain/solo brings its whole repo/.mrc (minus @member transcripts) into the repoId slice; a
// MEMBER brings ONLY its own transcript into its (org,handle) slice, so it RESUMES on the first store launch rather
// than re-starting (owner directive: no member re-start). Include-scoped → no sibling transcript bleeds into a member slice.
const migrateOpts = launchIsPlainOrSolo ? { migrate: true, exclude: storeExclude }
  : isMemberLaunch ? { migrate: true, include: new Set([memberCtx.sessionId]) }
  : { migrate: false }
const legacyDir = resolve(repoPath, '.mrc')
// #5: resolve the INTENDED slice PATH first — do NOT migrate yet (mrcStoreDir is pure path resolution). Migration
// is deferred until AFTER the GATE-3 fork check so a forking launch NEVER touches the contended slice — not even
// the sentinel-existsSync read migrate would do — honoring GATE-3's "don't touch a slice another container owns"
// literally, and decoupling the fork case from the migration's own two-process concurrency-safety.
let mrcDir = storeActive
  ? mrcStoreDir(storeCtx({ solo: config.solo, memberCtx, cagedAdversary, adversarySlot, repoPath }))
  : legacyDir
// #5 per-UUID COEXIST replaces the coarse per-slice refuse (owner chose coexist). Two same-repo sessions MAY run
// concurrently; they collide only if they'd --resume the SAME transcript, which the RESUME held-check (below, after
// the member block) prevents by picking a non-colliding conversation. The container per-UUID flock is the last-line
// floor. skipWrite: the v2 re-migration + normalize are slice WRITES → skip them when ANY container is live on this
// slice (never race a live agent); recovery/repair defer to a solo launch. Applies to EVERY path (plain/solo/member),
// probing the actual mrcDir (repoId slice or the member's own).
const EXIT_STORE_BUSY = 69   // EX_UNAVAILABLE — distinct so automation detects "conversation open elsewhere", not a generic failure
const sliceLive = storeActive ? probeSliceLive(mrcDir) : { id: null, determined: true }
const skipWrite = storeActive && (!!sliceLive.id || !sliceLive.determined)
if (storeActive && migrateOpts.migrate) migrateAndNormalize(legacyDir, mrcDir, { ...migrateOpts, skipWrite })
if (storeActive) volumes.push('-v', `${mrcDir}:/mrc`)

// #5: the member resume-vs-fresh decision (deferred here from the member block so it reads the POST-build store dir).
// Read the member's OWN phase dir — mrcDir is its (org,handle) slice in store-mode (where 2c makes it write),
// repo/.mrc in legacy — NOT raw repo/.mrc. Its own transcript was just migrated INTO that slice (include-scoped,
// above), so a member RESUMES on the first store launch; it starts fresh only when it genuinely has no prior
// transcript. This is the no-bypass fix for the member path.
if (memberCtx) {
  if (existsSync(resolve(mrcDir, `${memberCtx.sessionId}.jsonl`))) config.resumeSession = memberCtx.sessionId
  else config.newSession = true
}

// #5 per-UUID COEXIST — the RESUME held-check (plain/solo, store-mode). Coexist means a bare launch can't be refused,
// so a collision on the target conversation resolves by picking a DIFFERENT conversation, LOUDLY (never a silent
// blank — that's the "mrc lost my history" panic). Sequenced BEFORE RESUME_SESSION + resolveSessionId so the chosen
// uuid flows to the per-uuid lock (MRC_SESSION_ID) AND the room identity. Also HOST-RESOLVES the auto-continue so the
// container --resumes an exact uuid, killing the in-container --continue mtime-pick (deterministic, needed for the lock).
if (storeActive && launchIsPlainOrSolo && !config.newSession) {
  const explicit = !!config.resumeSession                                    // an explicit pick/resume set it; auto-continue leaves it unset
  const sessions = explicit ? null : getSessions(mrcDir, { exclude: storeExclude })
  const target = explicit ? config.resumeSession : (sessions[0] && sessions[0].uuid)
  if (target) {
    const { held, determined } = probeHeldUuids()
    const collide = held.has(target) || !determined                         // fail-closed: an unverifiable probe counts as "might be held"
    if (collide && explicit && !config.forceStore) {
      let nm; try { nm = loadNames(mrcDir)[target] } catch {}
      console.error(`\n  ✗ mrc: "${nm || target.slice(0, 8)}" is already open in another session — two sessions on one conversation corrupt it.`)
      console.error(`  → Close the other, \`mrc pick\` a different conversation, or --force-store to co-open it anyway (risky).\n`)
      process.exit(EXIT_STORE_BUSY)
    } else if (collide && explicit) {
      console.error(`  ! mrc: --force-store — co-opening a conversation already live elsewhere; simultaneous writes can corrupt it. You accepted the risk.`)
    } else if (collide) {                                                     // auto-continue collided → newest NOT-held, else FRESH; LOUD either way
      const free = determined ? sessions.find((s) => !held.has(s.uuid)) : null
      if (free) { config.resumeSession = free.uuid; config.resumeIsAuto = true; console.error(`  ! mrc: your most recent conversation is open in another session — continuing your next-most-recent here instead (your history is safe; \`mrc pick\` to choose a specific one).`) }
      else { config.newSession = true; console.error(`  ! mrc: your recent conversations are open in other sessions — starting a FRESH one here (your history is safe; \`mrc pick\` to open a specific past conversation).`) }
    } else if (!explicit) {                                                   // newest is FREE → host-resolve it (kill the in-container --continue mtime-pick)
      config.resumeSession = target; config.resumeIsAuto = true
    }
    // #4 honest coexist notice — once, when another session is genuinely live alongside us
    if (determined && held.size > 0) {
      console.error(`  ℹ mrc: running alongside another session on this repo — Claude Code's project /memory is SHARED and not concurrency-safe: a simultaneous memory edit can drop an index entry or lose a fact's content (last-write-wins). Your conversations are isolated.`)
    }
  }
}

// Environment flags
const envFlags = []
// No Anthropic key is ever injected into the container — the sandboxed session authenticates via
// the user's Max/OAuth login (persisted in the config volume). MRC_SESSION_NAMING_ANTHROPIC_API_KEY
// is host-only (Haiku naming/summaries in src/sessions/api.js); it never crosses into the sandbox.
if (openaiKey) envFlags.push('-e', 'OPENAI_API_KEY')
if (config.agent !== 'claude') envFlags.push('-e', `MRC_AGENT=${config.agent}`)
// belt 1: a caged adversary NEVER carries web egress — force it off before the ALLOW_WEB env is built (belt 2
// in the firewall is the backstop; the configEnvs loop below also strips any ALLOW_WEB from a trusted ~/.mrcrc).
if (config.summonedBy || config.cageAdversary) config.allowWeb = false
if (config.allowWeb) envFlags.push('-e', 'ALLOW_WEB=1')
// Two-bit adversary model: MRC_ADVERSARY_FW (CAGE → firewall hardening) is set for a summon OR a re-sandboxed
// resume, NOT --open-adversary-unsafe. MRC_ADVERSARY (IDENTITY → daemon classification, forwarded by the
// channel register) is set whenever THIS launch is an adversary, INCLUDING --open-adversary-unsafe.
if (config.summonedBy || config.cageAdversary) envFlags.push('-e', 'MRC_ADVERSARY_FW=1')
if (config.summonedBy || config.resumeIsAdversary) envFlags.push('-e', 'MRC_ADVERSARY=1')
if (config.resumeSession) envFlags.push('-e', `RESUME_SESSION=${config.resumeSession}`)
if (config.resumeIsAuto) envFlags.push('-e', 'MRC_RESUME_IS_AUTO=1')   // #5: the host force-resolved an AUTO-continue → on a per-uuid flock-fail TOCTOU, the entrypoint routes to graceful re-run, not the explicit-resume FATAL
if (config.newSession) envFlags.push('-e', 'NEW_SESSION=1')
envFlags.push('-e', `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '128000'}`)
envFlags.push('-e', `MRC_REPO_NAME=${basename(repoPath)}`)
for (const env of configEnvs) {
  if ((config.summonedBy || config.cageAdversary) && env.split('=')[0] === 'ALLOW_WEB') continue   // belt-1 complement: never carry ALLOW_WEB into a cage, even from a trusted ~/.mrcrc
  envFlags.push('-e', env)
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MRC_VIDEO_')) envFlags.push('-e', `${key}=${process.env[key]}`)
}

// A caged adversary can't run detached: its only egress is the host SNI proxy, which lives in THIS process.
if (cagedAdversary && config.daemon) {
  console.error('Refusing to launch a caged adversary in --daemon mode — its SNI egress proxy is interactive-only (it dies with the launcher).')
  process.exit(1)
}

// Daemon mode: start container in background, print container ID, exit
if (config.daemon) {
  const containerId = startDaemon({ repoPath, envFlags, volumes, allowWeb: config.allowWeb, image: pinnedImage || undefined })
  process.stdout.write(containerId + '\n')
  process.removeAllListeners('exit')
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
  process.exit(0)
}

// Start proxies (reuse ports pre-allocated above when rooms booted the daemon early).
if (!clipPort) clipPort = await findFreePort(portBase + 1)   // #50: portBase is reserved for the room relay; per-session proxies start above it
try {
  clipboardServer = await startClipboardProxy(clipPort)
  envFlags.push('-e', `MRC_CLIPBOARD_PORT=${clipPort}`)
} catch {
  console.log('  ! Clipboard proxy failed to start (image paste won\'t work)')
}

if (!notifyPort) notifyPort = await findFreePort(clipPort + 1)
if (!config.noNotify) {
  if (process.platform === 'darwin') {
    try { execFileSync('which', ['terminal-notifier'], { stdio: 'ignore' }) } catch {
      console.log('  ! terminal-notifier not found — install it for desktop notifications:')
      console.log('    brew install terminal-notifier')
      config.noNotify = true
    }
  }
  if (!config.noNotify) {
    try {
      notifyServer = await startNotifyProxy(notifyPort, { noSound: config.noSound })
      envFlags.push('-e', `MRC_NOTIFY_PORT=${notifyPort}`)
    } catch {
      console.log('  ! Notification proxy failed to start')
    }
  }
}

// A/#40: seal a caged adversary's egress behind the host SNI-pinning proxy. Combined with the firewall's
// zero direct egress (S7), this is the ONLY way out, and it validates the in-tunnel ClientHello SNI — catching
// a foreign SNI smuggled inside a CONNECT to the model host (the Cloudflare shared-edge ride an L3/L4 firewall
// is blind to). FAIL CLOSED: never launch an adversary with a hole where its only egress should be.
if (cagedAdversary) {
  try {
    const sniPort = await findFreePort(notifyPort + 1)
    sniProxyServer = await startSniProxy(sniPort)
    envFlags.push('-e', `MRC_SNI_PROXY_PORT=${sniPort}`)
    envFlags.push('-e', `HTTPS_PROXY=http://host.docker.internal:${sniPort}`, '-e', `https_proxy=http://host.docker.internal:${sniPort}`)
    envFlags.push('-e', 'NO_PROXY=localhost,127.0.0.1,host.docker.internal', '-e', 'no_proxy=localhost,127.0.0.1,host.docker.internal')
  } catch (e) {
    console.error(`Refusing to launch a caged adversary without a sealed egress path — the SNI proxy failed to start (${e?.message || e}).`)
    process.exit(1)
  }
}

// Room participation (default-on for interactive Claude; see roomsActive above). The daemon was
// booted earlier (roomDaemon); here we just wire this session's channel to it.
let roomInfo = null
if (roomsActive) {
  const { roomSessionEnv } = await import('./src/commands/pair.js')
  const { roomsRoot } = await import('./src/rooms.js')
  const daemon = roomDaemon
  if (memberCtx) {
    // Team member: the daemon ALREADY holds this org authoritatively — the OUTER launcher pushed it
    // (`mrc team up` at team.js pushOrg-before-launch, or the solo outer's startSoloSession), and it
    // survives a daemon restart via loadOrgs→defineOrg on boot. So the inner member does NOT (re)define
    // its org. #49-SEC/Door-2 (member-writable-roster confused deputy): the inner member must NEVER call
    // defineOrg — its roster (team.runtime.json) is member-writable (.mrc is bind-mounted rw), and
    // defineOrg is redefine-with-PRUNE (drops members/rooms + deletes their live bySession bindings), so a
    // member re-pushing a tampered `norm` could corrupt or DoS ANOTHER org's structure. Dropping the push
    // is verified redundant on every launch path; if no team-up ever defined the org, the register fails
    // LOUD at the daemon ("no pinned member identity — relaunch via `mrc team up`"), not silently.
    const sessionId = memberCtx.sessionId
    envFlags.push('-e', `MRC_ROOM_PORT=${daemon.port}`, '-e', `MRC_SESSION_ID=${sessionId}`, '-e', `MRC_REPO_NAME=${basename(repoPath)}`, '-e', `MRC_ROOM_LABEL=${memberCtx.member.first}`)
    envFlags.push(...memberCtx.envFlags)   // MRC_MEMBER_HANDLE, MRC_TEAM, MRC_ROLE, MRC_PERSONA_FILE
    volumes.push('-v', `${roomsRoot()}:/rooms:ro`)
    roomInfo = { sessionId, roomName: '', label: `${memberCtx.member.first} (@${memberCtx.member.handle})`, member: true }
  } else {
    // Stable session identity = the Claude conversation UUID, so a resumed conversation keeps its id
    // (rooms between the same two conversations resume) while a new conversation gets a fresh id —
    // pinned via `claude --session-id` in the entrypoint when RESUME_FLAG is empty.
    const sessionId = resolveSessionId(mrcDir, { resumeSession: config.resumeSession, newSession: config.newSession, exclude: launchIsPlainOrSolo ? storeExclude : null })   // #5: route through the store dir; a plain --continue never auto-resumes a @member
    // Human-readable label (alias) for `mrc rooms` + ask_peer matching: the session's name if it has
    // one, else the repo basename.
    let label = basename(repoPath)
    try { const nm = loadNames(mrcDir)[sessionId]; if (nm) label = nm } catch {}
    envFlags.push(...roomSessionEnv({ daemonPort: daemon.port, sessionId, repoName: basename(repoPath), repoPath, roomName: config.room, label, summonedBy: config.summonedBy || undefined }))
    if (cagedAdversary) {
      // D/#43: a caged adversary sees ONLY its own room, read-only — not the whole /rooms tree. Verify the
      // resolved path is a real subdir of roomsRoot() (defends a `..` in config.room); no valid room → no
      // /rooms mount at all (fail-closed — it just can't read a brief).
      const rid = config.room || ''
      const roomPath = resolve(roomsRoot(), rid)
      if (rid && roomPath.startsWith(roomsRoot() + '/') && existsSync(roomPath)) volumes.push('-v', `${roomPath}:/rooms/${rid}:ro`)
    } else {
      volumes.push('-v', `${roomsRoot()}:/rooms:ro`)
    }
    roomInfo = { sessionId, roomName: config.room || '', label }
  }
  // 3.A/#39: write this session's TAMPER-PROOF host-only containment record BEFORE the container launches
  // and its channel registers, so the daemon classifies from the record (never the forgeable wire frame).
  // The record lives host-side (~/.local/share/mrc/session-meta/) and is NEVER mounted into any container.
  // A normal session records `adversary:false`; a summoned adversary carries `--summoned-by` (Phase 3.B),
  // which flips `adversary:true` here — the daemon then cages it even if it omits the marker from its frame.
  // Prune first (touches only PRIOR sessions' records, and never an adversary's) to bound the dir.
  // R1/#44: a STABLE per-session register secret — generated once, REUSED on resume (via existingSec.secret),
  // written to the tamper-proof host record (never mounted → another container can't read it to impersonate)
  // AND injected so the channel authenticates this session at register. This runs for EVERY daemon-connected
  // launch (normal/member/summon/resume) in this always-runs spot, so the daemon can gate on the secret.
  try {
    pruneSessionRecords()
    const existingSec = loadSessionRecord(roomInfo.sessionId)
    const roomSecret = existingSec.secret || randomBytes(24).toString('hex')
    saveSessionRecord(roomInfo.sessionId, {
      repoPath,
      summonedBy: config.summonedBy || existingSec.summonedBy || undefined,
      adversary: cagedAdversary || !!existingSec.adversary,
      secret: roomSecret,
      ...(adversarySlot ? { slot: adversarySlot } : {}),
    })
    envFlags.push('-e', `MRC_ROOM_SECRET=${roomSecret}`)
  } catch (e) {
    // A caged adversary MUST have its host record — it's what the daemon classifies from. Fail closed:
    // launching without it would leave the adversary classified 'unknown' (uncaged in the daemon's eyes).
    // A NORMAL session tolerates a write failure (it registers unverified; the daemon alerts the human).
    if (cagedAdversary) { console.error(`Refusing to launch a caged adversary without its host security record: ${e?.message || e}`); process.exit(1) }
    dbg(`session-record write failed: ${e?.message || e}`)
  }
}

// #5 per-UUID: the container needs MRC_SESSION_ID for the per-conversation flock + deterministic --resume on EVERY
// store-mode launch, but the roomsActive block above only sets it for room sessions. Ensure it for a non-room store
// session (--daemon/--json/--no-rooms) — consistent with RESUME_SESSION/NEW_SESSION (resolveSessionId returns that id).
if (storeActive && !memberCtx && !roomInfo) {
  const sessionId = resolveSessionId(mrcDir, { resumeSession: config.resumeSession, newSession: config.newSession, exclude: launchIsPlainOrSolo ? storeExclude : null })
  envFlags.push('-e', `MRC_SESSION_ID=${sessionId}`)
}

// Banner
if (!config.json) {
  console.log(BANNER)
  console.log(`  → Repo:      ${repoPath}`)
  console.log(`  → Volume:    ${volName}`)
  console.log(`  → Schwartz:  ${[apiKey && 'Anthropic', openaiKey && 'OpenAI'].filter(Boolean).join(' + ')} engaged`)
  if (config.agent !== 'claude') console.log(`  → Agent:     ${config.agent}`)
  console.log(`  → Clipboard: ${cagedAdversary ? 'blocked (adversary cage)' : clipboardServer ? 'the Schwartz can see your clipboard' : 'disabled'}`)
  console.log(`  → Notify:    ${cagedAdversary ? 'blocked (adversary cage)' : notifyServer ? 'the Schwartz will alert you when ready' : 'disabled'}`)
  console.log(`  → Firewall:  ${cagedAdversary ? 'hardened cage — egress SNI-pinned to the model API (no direct net, no web)' : config.allowWeb ? 'jammed, but he can see the web (--web)' : 'jammed (just like their radar)'}`)
  if (roomInfo?.member) console.log(`  → Member:    ${roomInfo.label} — ${memberCtx.member.roleLabel} on team "${memberCtx.member.team}" · writes: ${memberCtx.member.mount === 'rw' ? memberCtx.member.territory : 'read-only'}`)
  else if (roomInfo) console.log(`  → Rooms:     "${roomInfo.label}" · ${roomInfo.roomName ? `explicit pair "${roomInfo.roomName}"` : 'ambient (say "ask <peer>: …")'}`)
  console.log('')
}

// Snapshot sessions for post-exit processing (Claude only — Codex has no .jsonl sessions)
// mrcDir declared above (#5 store-mode routing) — the post-session naming/summary reads/writes use it, so they land
// in the same slice the container wrote to (store-mode) or repo/.mrc (legacy).
let beforeSessions = []
if (config.agent === 'claude') {
  try { beforeSessions = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')) } catch {}
}

// Background name generator (#52: retry until a name actually lands; #14: name THIS session's pinned UUID). The retry
// + anti-hang core lives in src/sessions/name-watcher.js (injectable → unit-tested); wire it to THIS session's mrcDir.
// nameWhenReady(uuid) → true iff it engaged the pinned .jsonl, false iff that file never appeared (a future --session-id
// regression) → the caller falls through to the heuristic (the real file). See name-watcher.js for the status legend.
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms))
const { statSync } = await import('node:fs')
const { nameUntilDone, nameWhenReady } = makeNamer({
  generateName: (uuid) => generateName(mrcDir, uuid),
  statSync,
  jsonlPath: (uuid) => resolve(mrcDir, `${uuid}.jsonl`),
  sleep: sleepMs,
})
let nameWatcher = null
if (config.agent === 'claude' && !config.newSessionName && !config.noSummary && apiKey) {
  // EXIT-SAFETY INVARIANT (Pierre): this is a BACKGROUND IIFE, started before runContainer and NEVER awaited on the
  // main path — the unconditional `process.exit(exitCode)` after runContainer HARD-KILLS any pending poll. THAT is
  // what makes the in-session nameUntilDone(Infinity) / nameWhenReady growth-poll safe (an unbounded loop can't
  // outlive the session or block exit). Do NOT `await nameWatcher` on the main path, and keep process.exit(exitCode)
  // unconditional — the day either changes, Infinity becomes a real hang. (The post-exit fallbacks ARE awaited, so
  // those pass a bounded cap of 3.)
  nameWatcher = (async () => {
    // #14: rooms/members PIN this session's conversation UUID (MRC_SESSION_ID → `claude --session-id` → <id>.jsonl),
    // so name its OWN .jsonl directly. The files[last]/newFiles[0] heuristics below mis-name under CONCURRENT
    // same-repo launches (a fresh session grabs a peer's .jsonl). Non-rooms sessions (no pinned id) fall through.
    if (roomInfo?.sessionId) { if (await nameWhenReady(roomInfo.sessionId)) return }   // #14: on success, done; if the pinned .jsonl never appeared (a --session-id regression), FALL THROUGH to the heuristic (the file the container ACTUALLY wrote) — never leave it unnamed
    // Resumed (no pinned id): name the latest existing .jsonl if unnamed — a single attempt (it already has content).
    try {
      const files = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')).sort()
      if (files.length > 0) await generateName(mrcDir, basename(files[files.length - 1], '.jsonl'))
    } catch {}
    // New (no pinned id): wait (bounded) for the .jsonl to appear, then name-when-ready.
    for (let i = 0; i < 60; i++) {
      await sleepMs(5000)
      try {
        const after = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl'))
        const newFiles = after.filter(f => !beforeSessions.includes(f))
        if (newFiles.length > 0) { await nameWhenReady(basename(newFiles[0], '.jsonl')); break }
      } catch {}
    }
  })()
}

// Run container
const roomLabels = roomInfo
  ? ['--label', 'mrc.room=1', '--label', `mrc.room.session=${roomInfo.sessionId}`,
     ...(memberCtx ? ['--label', `mrc.member=${memberCtx.member.handle}`, '--label', `mrc.team=${memberCtx.member.team}`, '--label', `mrc.project=${memberCtx.org}`] : []),   // #49-SEC: authoritative org (blob/solo), not the member-writable roster's norm.org
     ...(cagedAdversary ? ['--label', 'mrc.adversary=1', '--label', `mrc.adversary.slot=${adversarySlot}`] : [])]   // the Pierre-slot pool's liveness oracle reads these labels
  : []
const exitCode = await runContainer({
  repoPath,
  envFlags,
  volumes,
  claudeArgs,
  allowWeb: config.allowWeb,
  json: config.json,
  labels: roomLabels,
  member: memberCtx?.member?.handle || null,   // #34: TERM=xterm-256color + mrc.member label for ttyd-hosted members
  image: pinnedImage || undefined,             // #5: run the PINNED image id (inspect+run same image); '' → IMAGE_NAME fallback
})

// --- Post-session processing (Claude only) ---
if (config.agent === 'claude') {
  let afterSessions = []
  try { afterSessions = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')) } catch {}
  const newFiles = afterSessions.filter(f => !beforeSessions.includes(f))

  if (newFiles.length > 0) {
    const newUuid = basename(newFiles[0], '.jsonl')

    // Name if --new was given with a name
    if (config.newSessionName) {
      nameSession(mrcDir, config.newSessionName, newUuid)
    }

    // Auto-generate name if none set (#52: bounded retry — the transcript is final, so a small cap covers a transient blip)
    if (!config.newSessionName && !config.noSummary && apiKey) {
      await nameUntilDone(newUuid, 3)
    }

    // Tool-miss detection
    const misses = detectToolMisses(mrcDir, newUuid)
    if (misses.size > 0 && !config.json) {
      let mrcRepoUrl = ''
      try {
        mrcRepoUrl = execFileSync('git', ['-C', SCRIPT_DIR, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/\.git$/, '')
      } catch {}
      mrcRepoUrl = mrcRepoUrl || 'https://github.com/aisaacs/mrc'

      console.log('')
      console.log("  ⚠ We ain't found these tools:")
      for (const [cmd, desc] of misses) {
        console.log(`    - ${cmd}: ${desc}`)
        const title = encodeURIComponent(`Add ${cmd} to Dockerfile`)
        const body = encodeURIComponent(`Session reported: ${cmd}: ${desc}\n\nConsider adding \`${cmd}\` to the apt-get install line in the Dockerfile.`)
        console.log(`      → ${mrcRepoUrl}/issues/new?title=${title}&body=${body}`)
      }
    }

    // Session summary (background)
    if (!config.noSummary && apiKey) {
      summarize(mrcDir, newUuid).catch(() => {})
    }
  }

  // Auto-name resumed sessions that are still unnamed
  if (newFiles.length === 0 && !config.noSummary && apiKey) {
    try {
      const latest = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')).sort().pop()
      if (latest) await nameUntilDone(basename(latest, '.jsonl'), 3)   // #52: bounded retry, on the REAL on-disk file (Pierre: never the pinned id — a phantom would make the backstop miss too)
    } catch {}
  }
}

process.exit(exitCode)
