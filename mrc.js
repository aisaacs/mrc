#!/usr/bin/env node
//
// mrc.js — Mister Claude
// Launch Claude Code in a sandboxed Docker container with network firewall.
//
import { resolve, basename, dirname, sep } from 'node:path'
import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import { BANNER } from './src/constants.js'
import { setVerbose, dbg } from './src/output.js'
import { readMrcrc, loadEnv, parseArgs, sanitizeRepoConfig } from './src/config.js'
import { ensureDocker } from './src/colima.js'
import { buildImage, checkImageAge, nextAdversarySlot, nextInstanceSlot, volumeName, runContainer, startDaemon, showStatus } from './src/docker.js'
import { processSandboxignores } from './src/sandboxignore.js'
import { findFreePort } from './src/ports.js'
import { startClipboardProxy } from './src/proxies/clipboard-proxy.js'
import { startNotifyProxy } from './src/proxies/notify-proxy.js'
import { startSniProxy } from './src/proxies/sni-proxy.js'
import { listSessions, nameSession, resolve as resolveSession, loadNames, loadMeta, saveMeta, getSessions, resolveSessionId } from './src/sessions/manager.js'
import { saveSessionRecord, isAdversarySession, loadSessionRecord, classifySession, pruneSessionRecords } from './src/session-record.js'
import { createInterface } from 'node:readline'
import { summarize, generateName } from './src/sessions/api.js'
import { pick, ensureNamesMigrated, ensureSecurityRecordsMigrated } from './src/sessions/picker.js'
import { detectToolMisses } from './src/sessions/transcript.js'
import { resolveContextDir } from './src/context.js'

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
const { flags: repoFlags, envs: repoEnvs } = readMrcrc(resolve(repoHint, '.mrcrc'))

// --- Belt 0 (security): <repo>/.mrcrc is sandbox-WRITABLE, so it's the least-trusted config source.
// sanitizeRepoConfig (config.js) ALLOWLISTS it (deny-by-default) HERE, BEFORE the merge below — so no
// unsanitized repo flag/env can reach parseArgs or `docker run -e`. CLI + host-only ~/.mrcrc are trusted
// and never pass through it. Stripped (not fatal) with a notice, so a stray entry is ignored not obeyed.
const { flags: repoFlagsSafe, envs: repoEnvsSafe } =
  sanitizeRepoConfig(repoFlags, repoEnvs, (msg) => console.error(`  ⚠ Ignoring ${msg}.`))

// Merge: config flags first, then CLI args (CLI overrides)
const configEnvs = [...globalEnvs, ...repoEnvsSafe]
const allArgs = [...globalFlags, ...repoFlagsSafe, ...process.argv.slice(2)]
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
  --room <name>        Pair only with another session that shares this --room name
  --no-rooms           Disable cross-session negotiation rooms for this session
  --no-summary         Skip AI session summary on exit
  --no-notify          Disable desktop notifications on response complete
  --no-sound           Disable notification sound (still shows notification)
  --colima-cpu N       CPUs for Colima VM (default: all host cores)
  --colima-memory N    Memory (GB) for Colima VM (default: half host RAM, min 8)

Commands:
  mrc status                              Show active containers across repos
  mrc pick [path]                         Interactive session picker (arrow keys)
  mrc rooms [...]                         Watch/steer negotiation rooms (mrc rooms --help)

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

// --- Load .env / API keys ---
// MRC_SESSION_NAMING_ANTHROPIC_API_KEY is host-only (Haiku naming/summaries). Legacy
// ANTHROPIC_API_KEY still works as a deprecated fallback (it collides with the key Claude Code
// auto-detects). Neither is ever injected into the container — the session runs on Max/OAuth.
loadEnv(SCRIPT_DIR, { skipOp: !!config.summonedBy })   // a summoned adversary needs no naming key — skip op:// (no Touch ID)
const apiKey = process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || ''
const legacyKeyVar = !process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY && !!process.env.ANTHROPIC_API_KEY
const openaiKey = process.env.OPENAI_API_KEY || ''
dbg(`Naming key: ${apiKey ? `set (${apiKey.length} chars)${legacyKeyVar ? ' [legacy ANTHROPIC_API_KEY]' : ''}` : 'NOT SET'}`)
dbg(`OpenAI key: ${openaiKey ? `set (${openaiKey.length} chars)` : 'NOT SET'}`)

// --- Adversary-aware session selection (#25) ---
// The picker LABELS adversary sessions; these gate actually OPENING one. Reconnecting to a summoned
// adversary (Pierre) is a legitimate, deliberate act (crash / restart / keep-context) — but never an
// accident, so we confirm. A non-TTY caller can't confirm, so it fails safe (NO).
async function askYesNo(q) {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try { return /^y(es)?$/i.test((await new Promise((r) => rl.question(`${q} [y/N] `, r))).trim()) }
  finally { rl.close() }
}
async function confirmIfAdversary(mrcDir, uuid) {
  if (!isAdversarySession(uuid)) return true
  const rec = loadSessionRecord(uuid)
  const issuer = loadNames(mrcDir)[rec.summonedBy] || (rec.summonedBy || '').slice(0, 8) || 'a prior session'
  const self = loadNames(mrcDir)[uuid] || 'this session'
  return askYesNo(`  ⚔  "${self}" is a RED-TEAM (adversary) session you summoned for "${issuer}". Reopen it?`)
}
// Apply a picker result to config: 'NEW' → fresh; a uuid → resume (confirming first if it's an
// adversary). Returns false if the human declined (caller should exit).
async function applyPickResult(result, mrcDir) {
  if (result === 'NEW') { config.newSession = true; return true }
  config.resumeSession = result   // a picked adversary is already confirmed inside the picker's TUI (confirmIfAdversary still guards the non-picker `sessions resume` path)
  return true
}

// --- Subcommand: mrc pick ---
if (remaining[0] === 'pick') {
  const repoPath = resolve(remaining[1] || '.')
  const result = await pick(resolve(repoPath, '.mrc'))
  if (!result) process.exit(0)
  config.allowWeb = true
  if (!(await applyPickResult(result, resolve(repoPath, '.mrc')))) process.exit(0)
  remaining.length = 0
}

// --- Subcommand: mrc sessions ---
if (remaining[0] === 'sessions') {
  const subcmd = remaining[1] || 'ls'
  const sessionsArgs = remaining.slice(2)

  switch (subcmd) {
    case 'ls': {
      const repoPath = resolve(sessionsArgs[0] || '.')
      await ensureNamesMigrated(resolve(repoPath, '.mrc'))
      listSessions(resolve(repoPath, '.mrc'))
      process.exit(0)
    }
    case 'name': {
      const name = sessionsArgs[0]
      const num = sessionsArgs[1] || '1'
      const repoPath = resolve(sessionsArgs[2] || '.')
      if (!name) { console.error('Usage: mrc sessions name <name> [#] [path]'); process.exit(1) }
      nameSession(resolve(repoPath, '.mrc'), name, num)
      process.exit(0)
    }
    case 'resume': {
      const query = sessionsArgs[0]
      const repoPath = resolve(sessionsArgs[1] || '.')
      if (!query) { console.error('Usage: mrc sessions resume <name-or-#> [path]'); process.exit(1) }
      const uuid = resolveSession(resolve(repoPath, '.mrc'), query)
      if (!uuid) { console.error(`Session not found: ${query}`); process.exit(1) }
      if (!(await confirmIfAdversary(resolve(repoPath, '.mrc'), uuid))) process.exit(0)   // adversary resume is deliberate on every path, not just the picker
      config.resumeSession = uuid
      remaining.length = 0
      break
    }
    case 'pick': {
      const repoPath = resolve(sessionsArgs[0] || '.')
      const result = await pick(resolve(repoPath, '.mrc'))
      if (!result) process.exit(0)
      config.allowWeb = true
      if (!(await applyPickResult(result, resolve(repoPath, '.mrc')))) process.exit(0)
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

if (config.agent === 'claude' && !apiKey && !config.summonedBy) {
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
  if (sniProxyServer) { sniProxyServer.close(); sniProxyServer = null }
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

// --- Adversary auto-resume guard (#25) + containment re-apply (#32) ---
// Runs BEFORE the volume claim (below) so a resumed adversary reattaches a Pierre slot + the cage,
// not a normal volume; and before the daemon boot/build so a declined picker exits cheaply.
//
// (a) Silent guard: a bare `mrc .` auto-continues the NEWEST session (by file mtime — getSessions is
//     mtime-primary to track what `claude --continue` actually resumes). If that's a summoned
//     adversary, never resume it silently — interactive surfaces the picker (reconnect is deliberate),
//     non-interactive starts fresh. RESIDUAL (documented, accepted with the lightweight choice): the
//     host's "newest" can still diverge from the container's own --continue oracle; on divergence an
//     adversary could AUTO-resume — but only onto the NORMAL sandbox, never a web escape (the cage in
//     (b) fires only on an EXPLICIT resume). The airtight closure (transcript isolation) was dropped.
pruneSessionRecords()   // host-only record dir grows one file per session; drop stale adversary:false records whose transcript is gone (NEVER an adversary; keep-on-ambiguity). Runs before this launch writes its own record, so it only touches PRIOR sessions.
if (config.agent === 'claude' && !config.newSession && !config.resumeSession) {
  const md = resolve(repoPath, '.mrc')
  // One-time legacy vouch (interactive): stamp pre-record sessions NORMAL so the guard below doesn't
  // picker-spam them. No-op once done / when there are none; only consumes the one-time on a TTY launch.
  if (process.stdin.isTTY && !config.json && !config.daemon) await ensureSecurityRecordsMigrated(md, repoPath)
  const newest = getSessions(md)[0]
  if (newest) {
    // 3-STATE fail-closed, keyed on record PRESENCE (not the 2-state isAdversarySession, which would
    // collapse "no record" into "normal" and never fire the keystone): an `adversary` record NEVER
    // auto-resumes (even under --no-rooms — a recorded adversary must not silently reopen); an `unknown`
    // (no record) fails closed ONLY under roomsActive (a --no-rooms/--json/--daemon launch writes no
    // record and can't be an adversary — a summon needs the daemon — so failing it closed would lose
    // auto-resume for scripted/non-TTY callers for zero safety); a `normal` record auto-resumes as before.
    // TTY → picker; non-TTY → fresh (fresh beats uncaged).
    const cls = classifySession(newest.uuid)
    if (cls === 'adversary' || (cls === 'unknown' && roomsActive)) {
      const why = cls === 'adversary'
        ? 'a red-team (adversary)'
        : 'unverified (no security record)'
      if (process.stdin.isTTY && !config.json && !config.daemon) {
        console.error(`  ⚔  Your most recent session here is ${why} — not auto-continuing it; pick one instead.`)
        const result = await pick(md)
        if (!result) process.exit(0)
        if (!(await applyPickResult(result, md))) process.exit(0)
      } else {
        console.error(`  ⚔  Most recent session here is ${why} — starting fresh instead of auto-resuming. Use \`mrc pick\` to reconnect.`)
        config.newSession = true
      }
    }
  }
}
// (b) #32 re-apply: an EXPLICIT resume of a summoned adversary (the resume path carries no
//     --summoned-by) re-applies the cage + reattaches a Pierre volume, from the durable host-only
//     record. --open-adversary-unsafe opts out (loud; belt 0 keeps it argv/~/.mrcrc-only). Cage =
//     belt 1 (allowWeb=false) + MRC_ADVERSARY_FW, set in the env-flags block. DECLASSIFICATION caveat:
//     deleting ~/.local/share/mrc/session-meta/ drops the adversary flag → that resume comes back uncaged.
if (!config.summonedBy && config.resumeSession && isAdversarySession(config.resumeSession)) {
  config.resumeIsAdversary = true
  if (config.openAdversaryUnsafe) {
    console.error('  ⚠  --open-adversary-unsafe: reopening this adversary session WITHOUT the cage (full egress). Its Pierre volume is reattached.')
  } else {
    config.cageAdversary = true
    console.error('  ⚔  Re-sandboxing this adversary session (hardened firewall, no web). Pass --open-adversary-unsafe to open it normally.')
  }
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
  clipPort = await findFreePort(portBase)
  notifyPort = await findFreePort(clipPort + 1)
  roomDaemon = await ensureRoomDaemon({ portBase: notifyPort + 1, notifyPort })
}

// Build image
const uid = process.getuid?.() ?? 1000
const gid = process.getgid?.() ?? 1000
buildImage(CONTEXT_DIR, { rebuild: config.rebuild, verbose: config.verbose, uid, gid })
checkImageAge(repoPath)

// Volumes. #45: a caged adversary gets /workspace READ-ONLY — a red-teamer reads the tree to critique it,
// it never needs to WRITE it (its output goes through the room/daemon). Its own transcript then lives in
// the RW config volume instead (container-setup.js skips the /workspace/.mrc symlink under the cage), so
// it can't tamper with the summoner's working tree OR another session's transcript. --open-adversary-unsafe
// (uncaged by explicit request) keeps RW, like a normal session. Gate = the cage bit (summon || resume-cage).
const cagedAdversary = !!(config.summonedBy || config.cageAdversary)
// A caged adversary's only egress is the host SNI-pinning proxy (A/#40), and that proxy is started in the
// interactive launch path below — NOT in --daemon (detached) mode, which early-exits before it. The summon
// path never uses --daemon (it spawns an interactive `mrc --new Pierre …`), so this is belt-and-suspenders:
// refuse the combination loudly rather than detach a cage with zero egress and no proxy to reach the model.
if (cagedAdversary && config.daemon) {
  console.error('  ✗ A caged adversary can\'t run in --daemon mode (its SNI-pinning egress proxy is interactive-only). Nothing launched.')
  process.exit(1)
}
const volumes = ['-v', `${repoPath}:/workspace${cagedAdversary ? ':ro' : ''}`]
volumes.push(...processSandboxignores(repoPath))

// Config volume per session. BOTH adversary and regular slots are claimed RACE-FREE + FAIL-CLOSED via an atomic
// O_EXCL claim (nextAdversarySlot / nextInstanceSlot): two concurrent same-repo launches can't grab the same
// volume — which would share one ~/.claude + its refresh token and log a session out — and a docker hiccup
// aborts the launch (retryable) rather than colliding onto a live volume. Adversaries get a DEDICATED `-pierre-N`
// pool (never a clone of your login — that clone was the orphan we hit; full rationale in docs/ + the rooms
// memory); regulars keep the ordinal `-N` model (slot 1 = the base `mrc-config-<hash>`). Log into a slot once,
// reuse it free thereafter (its own independent grant, so it can never orphan another session).
let volName, instanceId = 0, adversarySlot = 0
if (config.summonedBy || config.resumeIsAdversary) {
  // RACE-FREE O_EXCL claim for BOTH a fresh summon AND an adversary resume. Login-reuse: a resume PREFERS
  // its OWN stored Pierre slot, but claimed through the SAME race-free gate (used-check + O_EXCL) — so a
  // stored slot that's mounted-live or claimed by a sibling just falls through to lowest-free. No naive
  // reattach (that bypass collided concurrent resumes onto one ~/.claude → the #9 silent-logout); no #9.
  const preferredSlot = (config.resumeIsAdversary && config.resumeSession)
    ? (loadSessionRecord(config.resumeSession).slot || 0) : 0
  adversarySlot = nextAdversarySlot(repoPath, preferredSlot)
  if (!adversarySlot) {
    console.error('  ✗ Couldn\'t safely claim a Pierre slot (docker unreachable, or the slot dir is busy). Nothing launched — try again in a moment.')
    process.exit(1)
  }
  volName = `${volumeName(repoPath, 1)}-pierre-${adversarySlot}`
  console.log(config.resumeIsAdversary
    ? `  ⓘ Resuming adversary on Pierre slot ${adversarySlot}${adversarySlot === preferredSlot ? ' (its own slot)' : ''} — reuses this slot's login if it's been used, else a one-time login. Transcript rides the shared store.`
    : `  ⓘ Summoned adversary on Pierre slot ${adversarySlot} — reuses this slot's login if you've used it before, else a one-time login makes it permanent (no clone; it can't log you out).`)
} else {
  const claim = nextInstanceSlot(repoPath)
  if (!claim) {
    console.error('  ✗ Couldn\'t safely claim a config-volume slot (docker unreachable, or the slot dir is busy). Nothing launched — try again in a moment.')
    process.exit(1)
  }
  instanceId = claim.slot
  volName = volumeName(repoPath, instanceId)
  // "Others present?" comes from the SAME fail-closed mount-derived set (claim.others), not the old
  // getExistingCount fail-open: on a docker hiccup nextInstanceSlot already aborted above, so this can't
  // wrongly read 0-and-`--continue` two sessions onto the shared /workspace/.mrc transcript.
  if (claim.others > 0) {
    console.log('')
    console.log(`  ⚠ There's already ${claim.others} Mr. Claude running in this repo.`)
    console.log('    They\'ll share the workspace but get separate config volumes.')
    console.log('    Watch out for edit conflicts — two Claudes, one codebase, no good.')
    console.log('')
    if (!config.newSession && !config.resumeSession) config.newSession = true
  }
}
volumes.push('-v', `${volName}:/home/coder/.claude`)
// Codex config volume — skip it for summoned adversaries: Pierre always runs Claude (never codex), so the
// `mrc-codex-<…>-pierre-N` twin was only ever an empty, unused volume per Pierre slot. Regular sessions keep
// it (they may `--agent codex` on that slot later). Nothing in the container needs /home/coder/.codex unless
// the agent IS codex or OPENAI_API_KEY triggers a login (entrypoint.sh) — neither applies to a Claude Pierre.
if (!config.summonedBy) volumes.push('-v', `${volName.replace('mrc-config-', 'mrc-codex-')}:/home/coder/.codex`)

// Environment flags
const envFlags = []
// No Anthropic key is ever injected into the container — the sandboxed session authenticates via
// the user's Max/OAuth login (persisted in the config volume). MRC_SESSION_NAMING_ANTHROPIC_API_KEY
// is host-only (Haiku naming/summaries in src/sessions/api.js); it never crosses into the sandbox.
if (openaiKey) envFlags.push('-e', 'OPENAI_API_KEY')
if (config.agent !== 'claude') envFlags.push('-e', `MRC_AGENT=${config.agent}`)
// Belt 1 + (d): a summoned OR re-sandboxed-on-resume adversary NEVER gets web egress — overrides a
// --web from argv or ~/.mrcrc (a summon has no legit web use; belt 0 already blocks repo .mrcrc). The
// --open-adversary-unsafe path leaves cageAdversary unset, so it (and only it) keeps web.
if (config.summonedBy || config.cageAdversary) config.allowWeb = false
if (config.allowWeb) envFlags.push('-e', 'ALLOW_WEB=1')
if (config.summonedBy || config.cageAdversary) envFlags.push('-e', 'MRC_ADVERSARY_FW=1')   // CAGE bit → firewall (minimal allowlist + DNS-pinned). Summon OR re-sandboxed resume; NOT --open-adversary-unsafe.
if (config.summonedBy || config.resumeIsAdversary) envFlags.push('-e', 'MRC_ADVERSARY=1')   // IDENTITY bit → daemon classification. Set whenever THIS launch is an adversary, INCLUDING --open-adversary-unsafe (uncaged but still consent-protected). channel-server forwards it to the register; DECOUPLED from the cage bit so unsafe-open stays daemon-classified.
if (config.resumeSession) envFlags.push('-e', `RESUME_SESSION=${config.resumeSession}`)
if (config.newSession) envFlags.push('-e', 'NEW_SESSION=1')
envFlags.push('-e', `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '128000'}`)
envFlags.push('-e', `MRC_REPO_NAME=${basename(repoPath)}`)
for (const env of configEnvs) {
  // belt-1 complement to belt 2: a caged adversary must not even CARRY ALLOW_WEB — it can leak from the
  // TRUSTED global ~/.mrcrc (belt 0 only filters the repo file; belt 1's flag-check misses the env form),
  // and configEnvs is pushed straight to `docker -e`. Drop it here so the caged container never sees it.
  // belt 2 (the firewall) is the hard guarantee; this kills the leak host-side too + keeps the env honest.
  if ((config.summonedBy || config.cageAdversary) && env.split('=')[0] === 'ALLOW_WEB') continue
  envFlags.push('-e', env)
}
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MRC_VIDEO_')) envFlags.push('-e', `${key}=${process.env[key]}`)
}

// Daemon mode: start container in background, print container ID, exit
if (config.daemon) {
  const containerId = startDaemon({ repoPath, envFlags, volumes, allowWeb: config.allowWeb })
  process.stdout.write(containerId + '\n')
  process.removeAllListeners('exit')
  process.removeAllListeners('SIGINT')
  process.removeAllListeners('SIGTERM')
  process.exit(0)
}

// Start proxies (reuse ports pre-allocated above when rooms booted the daemon early).
if (!clipPort) clipPort = await findFreePort(portBase)
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

// A/#40 — SNI-pinning egress proxy for a CAGED adversary ONLY. The cage gets ZERO direct external
// egress (init-firewall.sh drops the ipset/443 allow); its sole route out is this host proxy, which
// peeks the in-tunnel ClientHello SNI and forwards only api.anthropic.com / platform.claude.com —
// sealing the Cloudflare shared-edge SNI-ride that an L3/L4 firewall is blind to. HTTPS_PROXY points
// the agent's TLS calls here; the room relay (raw TCP, not an HTTP client) ignores proxy env, so the
// volley is unaffected. NO_PROXY keeps loopback/host.docker.internal direct. Refuse to launch the
// adversary if the proxy can't start (fail-closed — no proxy means no sealed path out). A normal
// session never starts this and never sees the env: its direct egress is unchanged.
if (cagedAdversary) {
  const sniPort = await findFreePort(notifyPort + 1)
  try {
    sniProxyServer = await startSniProxy(sniPort)
    envFlags.push('-e', `MRC_SNI_PROXY_PORT=${sniPort}`)
    envFlags.push('-e', `HTTPS_PROXY=http://host.docker.internal:${sniPort}`)
    envFlags.push('-e', `https_proxy=http://host.docker.internal:${sniPort}`)
    envFlags.push('-e', 'NO_PROXY=localhost,127.0.0.1,host.docker.internal')
    envFlags.push('-e', 'no_proxy=localhost,127.0.0.1,host.docker.internal')
  } catch (e) {
    console.error(`  ✗ Couldn't start the adversary's SNI-pinning egress proxy (${e.message}). Refusing to launch a caged adversary without a sealed egress path. Nothing launched.`)
    process.exit(1)
  }
}

// Room participation (default-on for interactive Claude; see roomsActive above). The daemon was
// booted earlier (roomDaemon); here we just wire this session's channel to it.
let roomInfo = null
let roomSessionId = null   // the pinned conversation UUID (rooms only) so the name-watcher names THIS session's .jsonl, not a peer's
if (roomsActive) {
  const { roomSessionEnv } = await import('./src/commands/pair.js')
  const { roomsRoot } = await import('./src/rooms.js')
  const daemon = roomDaemon
  // Stable session identity = the Claude conversation UUID, so a resumed conversation keeps its id
  // (rooms between the same two conversations resume) while a new conversation gets a fresh id —
  // pinned via `claude --session-id` in the entrypoint when RESUME_FLAG is empty.
  const sessionId = resolveSessionId(resolve(repoPath, '.mrc'), { resumeSession: config.resumeSession, newSession: config.newSession })
  roomSessionId = sessionId   // hoisted so the name-watcher (below, outside this block) targets this session's own .jsonl
  // Per-session metadata record (single source of truth, keyed by the conversation UUID). Written here
  // because a rooms session has a PINNED uuid at launch (entrypoint --session-id); created once, merged
  // on every launch. The name is filled in later by the watcher / post-exit namer.
  const mrcDirRec = resolve(repoPath, '.mrc')
  try {
    const existing = loadMeta(mrcDirRec, sessionId)
    saveMeta(mrcDirRec, sessionId, { repoName: basename(repoPath), repoPath, createdAt: existing.createdAt || new Date().toISOString() })
  } catch {}
  // Host-only containment record (tamper-proof; the single source of truth for containment). Written for
  // EVERY session, every launch — `adversary:false` for a normal session is the KEYSTONE that makes
  // ABSENCE anomalous, which is what lets the resume guard fail CLOSED on a missing record. The adversary
  // flag is NEVER downgraded on resume (a resume carries no --summoned-by): it's true if THIS launch is a
  // summon, a re-opened adversary (resumeIsAdversary, incl. --open-adversary-unsafe), OR the existing
  // record already says so. Stores repoPath (for the transcript-coupled prune) + the Pierre slot (login-reuse).
  let roomSecret
  try {
    const existingSec = loadSessionRecord(sessionId)
    const isAdv = !!config.summonedBy || !!config.resumeIsAdversary || !!existingSec.adversary
    // G/#44: a STABLE per-UUID register secret — generated once, reused on resume (so a resumed session
    // re-claims its own id even if the daemon hasn't reaped its old socket yet). Host-only + never mounted,
    // so another container can't read it to impersonate this session.
    roomSecret = existingSec.secret || randomBytes(24).toString('hex')
    saveSessionRecord(sessionId, {
      adversary: isAdv,
      summonedBy: config.summonedBy || existingSec.summonedBy || null,
      repoPath,
      secret: roomSecret,
      ...(isAdv && adversarySlot ? { slot: adversarySlot } : {}),
    })
  } catch (e) {
    // B/#39 fail-closed: a NORMAL session tolerates a record-write failure (it classifies 'unknown' → the
    // daemon alerts the human). But an ADVERSARY with no durable record is exactly the split-brain we're
    // closing — firewall-caged yet daemon-classified-normal — so refuse to launch one we can't record.
    if (config.summonedBy || config.resumeIsAdversary) {
      console.error(`  ✗ Couldn't write the adversary's security record (${e.message}). Refusing to launch an unrecorded adversary. Nothing launched.`)
      process.exit(1)
    }
  }
  // Human-readable label (alias) for `mrc rooms` + ask_peer matching: the record's name (source of
  // truth), then the legacy session-names projection (transitional fallback), else the repo basename.
  let label = basename(repoPath)
  try { const nm = loadMeta(mrcDirRec, sessionId).name || loadNames(mrcDirRec)[sessionId]; if (nm) label = nm } catch {}
  if (config.newSessionName) label = config.newSessionName   // an explicit --new <name> shows live in list_peers from register, not only on the next resume
  envFlags.push(...roomSessionEnv({ daemonPort: daemon.port, sessionId, repoName: basename(repoPath), repoPath, roomName: config.room, label, summonedBy: config.summonedBy, secret: roomSecret }))
  // D/#43: a caged adversary gets ONLY its own room dir (never the whole rooms tree → no cross-project
  // harvest of every project's thread.log/consensus/briefs). The fresh-summon path always carries --room;
  // mount just that subdir read-only. A resumed adversary without --room (rare) gets NO /rooms mount — live
  // relay still works, just no on-disk catch-up (fail-closed). A regular session keeps the FULL tree: it's
  // one trust domain and must see rooms created at runtime (ask_peer), whose ids aren't known at launch.
  if (cagedAdversary) {
    // D/#43: mount only the adversary's OWN room dir. Containment check — basename does NOT defang '..'
    // (basename('..')==='..'), so verify the RESOLVED path is a real SUBDIR of roomsRoot before mounting,
    // not just that basename left it unchanged.
    const rid = config.room ? basename(config.room) : null
    const roomPath = rid ? resolve(roomsRoot(), rid) : null
    if (roomPath && roomPath.startsWith(roomsRoot() + sep) && existsSync(roomPath)) {
      volumes.push('-v', `${roomPath}:/rooms/${rid}:ro`)
    }
  } else {
    volumes.push('-v', `${roomsRoot()}:/rooms:ro`)   // read-only: the container only READS briefs/thread/consensus; every write goes through the daemon (host-side), so rw was needless privilege that let any sandbox forge another room's audit log or swap a consented brief
  }
  roomInfo = { sessionId, roomName: config.room || '', label }
}

// Banner
if (!config.json) {
  console.log(BANNER)
  console.log(`  → Repo:      ${repoPath}`)
  console.log(`  → Volume:    ${volName}`)
  console.log(`  → Schwartz:  ${[apiKey && 'Anthropic', openaiKey && 'OpenAI'].filter(Boolean).join(' + ')} engaged`)
  if (config.agent !== 'claude') console.log(`  → Agent:     ${config.agent}`)
  // A caged adversary can't actually reach the clipboard or notify proxies — the firewall (F/#41) drops
  // those host ports, keeping only the room relay. So the banner must say so, not claim they work (the same
  // honesty fix as the consent text). cagedAdversary = the cage bit set above (summon || re-sandboxed resume).
  console.log(`  → Clipboard: ${cagedAdversary ? 'blocked (adversary cage)' : clipboardServer ? 'the Schwartz can see your clipboard' : 'disabled'}`)
  console.log(`  → Notify:    ${cagedAdversary ? 'blocked (adversary cage)' : notifyServer ? 'the Schwartz will alert you when ready' : 'disabled'}`)
  console.log(`  → Firewall:  ${cagedAdversary ? 'hardened cage — egress SNI-pinned to the model API (no direct net, no web)' : config.allowWeb ? 'jammed, but he can see the web (--web)' : 'jammed (just like their radar)'}`)
  if (roomInfo) console.log(`  → Rooms:     "${roomInfo.label}" · ${roomInfo.roomName ? `explicit pair "${roomInfo.roomName}"` : 'ambient (say "ask <peer>: …")'}`)
  console.log('')
}

// Snapshot sessions for post-exit processing (Claude only — Codex has no .jsonl sessions)
const mrcDir = resolve(repoPath, '.mrc')
let beforeSessions = []
if (config.agent === 'claude') {
  try { beforeSessions = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')) } catch {}
}

// Background name generator
let nameWatcher = null
if (config.agent === 'claude' && !config.newSessionName && !config.noSummary && apiKey) {
  // No relabel push: the daemon reads each session's name from its on-disk record at use-time (single
  // source of truth), so generateName writing that record is ALL that's needed — list_peers/status pick it
  // up on the next read. (The old relabel-to-daemon wire was a cache-sync the SSOT design removed.)
  nameWatcher = (async () => {
    // Rooms pins THIS session's conversation UUID — name its OWN .jsonl directly. The heuristics below
    // (files[last] / newFiles[0]) mis-name under concurrent same-repo sessions: a fresh session grabs a
    // peer's .jsonl. Wait for ~10KB of content, then name + relabel. Non-rooms sessions (no pinned id)
    // fall through to the heuristic.
    if (roomSessionId) {
      const file = resolve(mrcDir, `${roomSessionId}.jsonl`)
      let big = false
      for (let j = 0; j < 120; j++) {
        try { if (statSync(file).size >= 10240) { big = true; break } } catch {}
        await new Promise((r) => setTimeout(r, 5000))
      }
      // Only name once there's enough transcript to extract a real name from. The 10KB threshold is a
      // GUARD, not just a wait: a session opened and left idle never crosses it, so it stays unnamed
      // instead of firing on an empty transcript (which the namer rejects as "no transcript provided").
      if (big) await generateName(mrcDir, roomSessionId)
      return
    }
    // For resumed sessions, name immediately if unnamed
    try {
      const files = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')).sort()
      if (files.length > 0) {
        const uuid = basename(files[files.length - 1], '.jsonl')
        await generateName(mrcDir, uuid)
      }
    } catch {}

    // For new sessions, wait for a new JSONL to appear
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000))
      try {
        const after = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl'))
        const newFiles = after.filter(f => !beforeSessions.includes(f))
        if (newFiles.length > 0) {
          // Wait for enough conversation (~10KB) — and only name if it actually gets there, so an
          // idle/empty new session doesn't fire naming on an empty transcript.
          const newFile = resolve(mrcDir, newFiles[0])
          let big = false
          for (let j = 0; j < 60; j++) {
            await new Promise(r => setTimeout(r, 5000))
            try { if (statSync(newFile).size >= 10240) { big = true; break } } catch {}
          }
          if (big) {
            const uuid = basename(newFiles[0], '.jsonl')
            await generateName(mrcDir, uuid)
          }
          break
        }
      } catch {}
    }
  })()
}

// Run container
const roomLabels = roomInfo
  ? ['--label', 'mrc.room=1', '--label', `mrc.room.session=${roomInfo.sessionId}`]
  : []
// Tag summoned adversaries with their Pierre-pool slot, so nextAdversarySlot() can see which slots are in use
// (its oracle filters mrc.adversary=1 and reads mrc.adversary.slot). Regular sessions need no slot label —
// nextInstanceSlot derives their slots from the config-volume MOUNTS, so `-pierre-N` is naturally excluded.
if (adversarySlot) roomLabels.push('--label', 'mrc.adversary=1', '--label', `mrc.adversary.slot=${adversarySlot}`)
const exitCode = await runContainer({
  repoPath,
  envFlags,
  volumes,
  claudeArgs,
  allowWeb: config.allowWeb,
  json: config.json,
  labels: roomLabels,
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

    // Auto-generate name if none set
    if (!config.newSessionName && !config.noSummary && apiKey) {
      await generateName(mrcDir, newUuid)
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
      if (latest) await generateName(mrcDir, basename(latest, '.jsonl'))
    } catch {}
  }
}

process.exit(exitCode)
