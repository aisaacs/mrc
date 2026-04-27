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
import { readMrcrc, loadEnv, parseArgs } from './src/config.js'
import { ensureDocker } from './src/colima.js'
import { buildImage, checkImageAge, getExistingCount, volumeName, runContainer, showStatus } from './src/docker.js'
import { processSandboxignores } from './src/sandboxignore.js'
import { findFreePort } from './src/ports.js'
import { startClipboardProxy } from './src/proxies/clipboard-proxy.js'
import { startNotifyProxy } from './src/proxies/notify-proxy.js'
import { listSessions, nameSession, resolve as resolveSession } from './src/sessions/manager.js'
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
  console.log(`Usage: mrc [options] [path-to-repo] [-- claude-code-args...]

Options:
  -r, --rebuild        Force a full image rebuild (no cache)
  -v, --verbose        Show Colima and Docker output (useful for debugging)
  -n, --new [name]     Start a new conversation (optionally named)
  -w, --web            Allow outbound HTTPS to any host (for web search/fetch)
  --no-summary         Skip AI session summary on exit
  --no-notify          Disable desktop notifications on response complete
  --no-sound           Disable notification sound (still shows notification)

Commands:
  mrc status                              Show active containers across repos
  mrc pick [path]                         Interactive session picker (arrow keys)

Session management:
  mrc sessions ls [path]                  List saved sessions
  mrc sessions name <name> [#] [path]     Name a session (default: most recent)
  mrc sessions resume <name-or-#> [path]  Resume a specific session
  mrc sessions pick [path]                Interactive session picker (alias for mrc pick)

Examples:
  mrc ~/projects/myapp
  mrc ~/projects/myapp -- --model claude-sonnet-4-5-20250929
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
  ANTHROPIC_API_KEY  — loaded from .env next to this script if present
  MRC_PORT_BASE      — starting port for proxy allocation (default: 7722)`)
  process.exit(0)
}

setVerbose(config.verbose)

// --- Subcommand: mrc status (runs without API key) ---
if (remaining[0] === 'status') {
  showStatus()
  process.exit(0)
}

// --- Load .env / API key ---
const opKey = loadEnv(SCRIPT_DIR)
const apiKey = opKey || process.env.ANTHROPIC_API_KEY || ''
if (apiKey) process.env.ANTHROPIC_API_KEY = apiKey
dbg(`API key: ${apiKey ? `set (${apiKey.length} chars)` : 'NOT SET'}`)

if (!apiKey) {
  console.log(`
  ⚠ The Schwartz is not with you... no API key found!

  "I can't make it work without the combination!"
     — Colonel Sandurz, probably talking about this .env file

  mrc needs an Anthropic API key for session naming and summaries.
  This is NOT your Claude Code subscription — it's a separate key
  for Haiku API calls. Think of it as the combination to the air shield.

  To unlock Druidia's fresh air supply:

    1. Install the 1Password CLI (op)
    2. Create a .env file next to the mrc script:
       ${SCRIPT_DIR}/.env
    3. Add this line:

       ANTHROPIC_API_KEY="op://Engineering/MRC Claude API key/credential"

  May the Schwartz be with you!
`)
  process.exit(1)
}

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

// --- Main launch flow ---
const repoPath = resolve(remaining[0] || '.')

// Ensure Docker / Colima
const startedColima = await ensureDocker(config.verbose)

// Cleanup on exit
let clipboardServer = null
let notifyServer = null

function cleanup() {
  if (clipboardServer) { clipboardServer.close(); clipboardServer = null }
  if (notifyServer) { notifyServer.close(); notifyServer = null }
  if (startedColima) {
    console.log('\n🎩 Goodbye, Lone Starr.')
    try { execFileSync('colima', ['stop'], { stdio: 'ignore' }) } catch {}
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

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

// Environment flags
const envFlags = []
if (apiKey) envFlags.push('-e', 'ANTHROPIC_API_KEY')
if (config.allowWeb) envFlags.push('-e', 'ALLOW_WEB=1')
if (config.resumeSession) envFlags.push('-e', `RESUME_SESSION=${config.resumeSession}`)
if (config.newSession) envFlags.push('-e', 'NEW_SESSION=1')
envFlags.push('-e', `CLAUDE_CODE_MAX_OUTPUT_TOKENS=${process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS || '128000'}`)
envFlags.push('-e', `MRC_REPO_NAME=${basename(repoPath)}`)
for (const env of configEnvs) envFlags.push('-e', env)
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MRC_VIDEO_')) envFlags.push('-e', `${key}=${process.env[key]}`)
}

// Start proxies
const portBase = Number(process.env.MRC_PORT_BASE) || 7722
const clipPort = await findFreePort(portBase)
try {
  clipboardServer = await startClipboardProxy(clipPort)
  envFlags.push('-e', `MRC_CLIPBOARD_PORT=${clipPort}`)
} catch {
  console.log('  ! Clipboard proxy failed to start (image paste won\'t work)')
}

const notifyPort = await findFreePort(clipPort + 1)
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

// Banner
console.log(BANNER)
console.log(`  → Repo:      ${repoPath}`)
console.log(`  → Volume:    ${volName}`)
console.log(`  → Schwartz:  engaged (API key)`)
console.log(`  → Clipboard: ${clipboardServer ? 'the Schwartz can see your clipboard' : 'disabled'}`)
console.log(`  → Notify:    ${notifyServer ? 'the Schwartz will alert you when ready' : 'disabled'}`)
console.log(`  → Firewall:  ${config.allowWeb ? 'jammed, but he can see the web (--web)' : 'jammed (just like their radar)'}`)
console.log('')

// Snapshot sessions for post-exit processing
const mrcDir = resolve(repoPath, '.mrc')
let beforeSessions = []
try { beforeSessions = readdirSync(mrcDir).filter(f => f.endsWith('.jsonl')) } catch {}

// Background name generator
let nameWatcher = null
if (!config.newSessionName && !config.noSummary && apiKey) {
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
const exitCode = await runContainer({
  repoPath,
  envFlags,
  volumes,
  claudeArgs,
  allowWeb: config.allowWeb,
})

// --- Post-session processing ---
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
  if (misses.size > 0) {
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

process.exit(exitCode)
