#!/usr/bin/env node
//
// mrc.js — Mister Claude
// Launch Claude Code in a sandboxed Docker container with network firewall.
//
import { resolve, basename, dirname } from 'node:path'
import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { BANNER } from './src/constants.js'
import { setVerbose, dbg } from './src/output.js'
import { readMrcrc, loadEnv, parseArgs, resolveOpEnv } from './src/config.js'
import { ensureDocker } from './src/colima.js'
import { buildImage, checkImageAge, getExistingCount, volumeName, runContainer, startDaemon, showStatus } from './src/docker.js'
import { processSandboxignores } from './src/sandboxignore.js'
import { findFreePort } from './src/ports.js'
import { startClipboardProxy } from './src/proxies/clipboard-proxy.js'
import { startNotifyProxy } from './src/proxies/notify-proxy.js'
import { listSessions, nameSession, resolve as resolveSession, loadNames, resolveSessionId } from './src/sessions/manager.js'
import { summarize, generateName } from './src/sessions/api.js'
import { pick, ensureNamesMigrated } from './src/sessions/picker.js'
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
  MRC_PORT_BASE      — starting port for proxy allocation (default: 7722)

Per-repo .mrcrc env lines (KEY=VALUE) are injected into the container; an op://
value is resolved via 1Password on the host. Set MRC_EXTRA_DOMAINS there to allow
extra firewall domains (e.g. mcp.linear.app) for one repo without --web.`)
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
loadEnv(SCRIPT_DIR)
const apiKey = process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || ''
const legacyKeyVar = !process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY && !!process.env.ANTHROPIC_API_KEY
const openaiKey = process.env.OPENAI_API_KEY || ''
dbg(`Naming key: ${apiKey ? `set (${apiKey.length} chars)${legacyKeyVar ? ' [legacy ANTHROPIC_API_KEY]' : ''}` : 'NOT SET'}`)
dbg(`OpenAI key: ${openaiKey ? `set (${openaiKey.length} chars)` : 'NOT SET'}`)

// --- Subcommand: mrc pick ---
if (remaining[0] === 'pick') {
  const repoPath = resolve(remaining[1] || '.')
  const result = await pick(resolve(repoPath, '.mrc'))
  if (!result) process.exit(0)
  config.allowWeb = true
  if (result === 'NEW') {
    config.newSession = true
  } else {
    config.resumeSession = result
  }
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
      config.resumeSession = uuid
      remaining.length = 0
      break
    }
    case 'pick': {
      const repoPath = resolve(sessionsArgs[0] || '.')
      const result = await pick(resolve(repoPath, '.mrc'))
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

if (config.agent === 'claude' && !apiKey) {
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
let roomBroker = null

function cleanup() {
  if (clipboardServer) { clipboardServer.close(); clipboardServer = null }
  if (notifyServer) { notifyServer.close(); notifyServer = null }
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

// Volumes
const volumes = ['-v', `${repoPath}:/workspace`]
volumes.push(...processSandboxignores(repoPath))

// Config volume (per-repo, with multi-instance support)
const existingCount = getExistingCount(repoPath)
if (existingCount > 0) {
  console.log('')
  console.log(`  ⚠ There's already ${existingCount} Mr. Claude running in this repo.`)
  console.log('    They\'ll share the workspace but get separate config volumes.')
  console.log('    Watch out for edit conflicts — two Claudes, one codebase, no good.')
  console.log('')
  if (!config.newSession && !config.resumeSession) config.newSession = true
}

const instanceId = existingCount > 0 ? existingCount + 1 : 1
const volName = volumeName(repoPath, instanceId)
volumes.push('-v', `${volName}:/home/coder/.claude`)
volumes.push('-v', `${volName.replace('mrc-config-', 'mrc-codex-')}:/home/coder/.codex`)

// Environment flags
const envFlags = []
// No Anthropic key is ever injected into the container — the sandboxed session authenticates via
// the user's Max/OAuth login (persisted in the config volume). MRC_SESSION_NAMING_ANTHROPIC_API_KEY
// is host-only (Haiku naming/summaries in src/sessions/api.js); it never crosses into the sandbox.
if (openaiKey) envFlags.push('-e', 'OPENAI_API_KEY')
if (config.agent !== 'claude') envFlags.push('-e', `MRC_AGENT=${config.agent}`)
if (config.allowWeb) envFlags.push('-e', 'ALLOW_WEB=1')
if (config.resumeSession) envFlags.push('-e', `RESUME_SESSION=${config.resumeSession}`)
if (config.newSession) envFlags.push('-e', 'NEW_SESSION=1')
envFlags.push('-e', `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '128000'}`)
envFlags.push('-e', `MRC_REPO_NAME=${basename(repoPath)}`)
// Inject per-repo/global .mrcrc env vars. An op:// value is resolved host-side and passed by name
// (keeping the secret out of the docker argv); everything else passes through verbatim.
for (const env of configEnvs) {
  const op = resolveOpEnv(env)
  if (op) { process.env[op.key] = op.value; envFlags.push('-e', op.key) }
  else envFlags.push('-e', env)
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

// Room participation (default-on for interactive Claude; see roomsActive above). The daemon was
// booted earlier (roomDaemon); here we just wire this session's channel to it.
let roomInfo = null
if (roomsActive) {
  const { roomSessionEnv } = await import('./src/commands/pair.js')
  const { roomsRoot } = await import('./src/rooms.js')
  const daemon = roomDaemon
  // Stable session identity = the Claude conversation UUID, so a resumed conversation keeps its id
  // (rooms between the same two conversations resume) while a new conversation gets a fresh id —
  // pinned via `claude --session-id` in the entrypoint when RESUME_FLAG is empty.
  const sessionId = resolveSessionId(resolve(repoPath, '.mrc'), { resumeSession: config.resumeSession, newSession: config.newSession })
  // Human-readable label (alias) for `mrc rooms` + ask_peer matching: the session's name if it has
  // one, else the repo basename.
  let label = basename(repoPath)
  try { const nm = loadNames(resolve(repoPath, '.mrc'))[sessionId]; if (nm) label = nm } catch {}
  envFlags.push(...roomSessionEnv({ daemonPort: daemon.port, sessionId, repoName: basename(repoPath), roomName: config.room, label }))
  volumes.push('-v', `${roomsRoot()}:/rooms`)
  roomInfo = { sessionId, roomName: config.room || '', label }
}

// Banner
if (!config.json) {
  console.log(BANNER)
  console.log(`  → Repo:      ${repoPath}`)
  console.log(`  → Volume:    ${volName}`)
  console.log(`  → Schwartz:  ${[apiKey && 'Anthropic', openaiKey && 'OpenAI'].filter(Boolean).join(' + ')} engaged`)
  if (config.agent !== 'claude') console.log(`  → Agent:     ${config.agent}`)
  console.log(`  → Clipboard: ${clipboardServer ? 'the Schwartz can see your clipboard' : 'disabled'}`)
  console.log(`  → Notify:    ${notifyServer ? 'the Schwartz will alert you when ready' : 'disabled'}`)
  console.log(`  → Firewall:  ${config.allowWeb ? 'jammed, but he can see the web (--web)' : 'jammed (just like their radar)'}`)
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
  nameWatcher = (async () => {
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
          // Wait for enough conversation (~10KB)
          const newFile = resolve(mrcDir, newFiles[0])
          for (let j = 0; j < 60; j++) {
            await new Promise(r => setTimeout(r, 5000))
            try {
              const { statSync } = await import('node:fs')
              if (statSync(newFile).size >= 10240) break
            } catch {}
          }
          const uuid = basename(newFiles[0], '.jsonl')
          await generateName(mrcDir, uuid)
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
