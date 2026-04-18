#!/usr/bin/env node
//
// container-setup.js — Container-side config initialization.
// Called by entrypoint.sh after the firewall is up.
// Handles: plugin seeding, config restore, symlinks, hooks, statusline.
//
import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, cpSync, rmSync, lstatSync, statSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

const HOME = process.env.HOME || '/home/coder'
const CLAUDE_DIR = join(HOME, '.claude')
const DEFAULTS_DIR = join(HOME, '.claude-defaults')
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json')
const CONFIG_FILE = join(CLAUDE_DIR, 'claude.json')
const MRC_LOCAL = '/workspace/.mrc'
const PROJECT_STORE = join(CLAUDE_DIR, 'projects', '-workspace')

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function writeJSON(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

// Symlink `src` to `dst` so image updates propagate on rebuild. Handles three cases:
//   - dst missing: create symlink
//   - dst is a symlink: no-op (already linked)
//   - dst is a real file/dir: migrate from legacy cpSync'd copy to symlink
//     - for files, only migrates when content matches src (preserves customizations)
//     - for dirs, migrates unconditionally (deep content comparison isn't practical;
//       plugin directories are not expected to be edited in place)
function linkOrMigrate(src, dst) {
  if (!existsSync(src)) return
  mkdirSync(dirname(dst), { recursive: true })

  if (!existsSync(dst)) {
    symlinkSync(src, dst)
    return
  }

  try {
    if (lstatSync(dst).isSymbolicLink()) return
  } catch { return }

  try {
    const stat = statSync(dst)
    if (stat.isFile()) {
      if (!readFileSync(src).equals(readFileSync(dst))) return  // user customized
      rmSync(dst)
    } else {
      rmSync(dst, { recursive: true, force: true })
    }
    symlinkSync(src, dst)
  } catch {}
}

// Copy `src` to `dst` if `dst` doesn't exist. Use for user-mutable templates
// where the copy is meant to be edited.
function copyIfAbsent(src, dst) {
  if (!existsSync(src)) return
  mkdirSync(dirname(dst), { recursive: true })
  if (!existsSync(dst)) cpSync(src, dst)
}

// 1. Seed plugins from build-time defaults into the persistent volume.
// Symlinks each marketplace and cached plugin individually so updates propagate
// on rebuild, while user-installed plugins (real dirs) and customizations (user
// replaced the symlink) are preserved.
if (existsSync(DEFAULTS_DIR)) {
  for (const subdir of ['marketplaces', 'cache']) {
    const src = join(DEFAULTS_DIR, 'plugins', subdir)
    const dst = join(CLAUDE_DIR, 'plugins', subdir)
    if (!existsSync(src)) continue
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src)) {
      linkOrMigrate(join(src, entry), join(dst, entry))
    }
  }

  const defaultSettings = readJSON(join(DEFAULTS_DIR, 'settings.json'))
  if (defaultSettings) {
    const current = readJSON(SETTINGS_FILE)
    if (!current) {
      writeJSON(SETTINGS_FILE, defaultSettings)
    } else {
      current.enabledPlugins = { ...defaultSettings.enabledPlugins, ...current.enabledPlugins }
      writeJSON(SETTINGS_FILE, current)
    }
  }
}

// 1b. Seed video-analysis command and default config.
// Command is symlinked so image updates propagate; config is copied because
// it's meant to be modified by the agent or user.
const VA_SRC = '/opt/mrc-video-analysis'
if (existsSync(VA_SRC)) {
  // Purge legacy video-frames artifacts from previous versions
  const legacyPaths = [
    join(CLAUDE_DIR, 'commands', 'video-frames.md'),
    join(CLAUDE_DIR, 'skills', 'video-analysis'),  // entire dir; skill consolidated into command
  ]
  for (const p of legacyPaths) {
    if (existsSync(p)) {
      try {
        const stat = lstatSync(p)
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          rmSync(p, { recursive: true, force: true })
        } else {
          rmSync(p)
        }
      } catch {}
    }
  }

  // Migrate config file: video-frames.json → video-analysis.json
  const legacyCfg = join(MRC_LOCAL, 'video-frames.json')
  const newCfg = join(MRC_LOCAL, 'video-analysis.json')
  if (existsSync(legacyCfg) && !existsSync(newCfg)) {
    cpSync(legacyCfg, newCfg)
    rmSync(legacyCfg)
  }

  linkOrMigrate(join(VA_SRC, 'command.md'), join(CLAUDE_DIR, 'commands', 'video-analysis.md'))
  copyIfAbsent(join(VA_SRC, 'defaults.json'), newCfg)
}

// 2. Restore claude.json from backup if missing
if (!existsSync(CONFIG_FILE)) {
  const backupDir = join(CLAUDE_DIR, 'backups')
  try {
    const backups = readdirSync(backupDir)
      .filter(f => f.startsWith('.claude.json.backup.'))
      .sort((a, b) => statSync(join(backupDir, b)).mtimeMs - statSync(join(backupDir, a)).mtimeMs)
    if (backups.length > 0) {
      console.log('Restoring Claude config from backup...')
      cpSync(join(backupDir, backups[0]), CONFIG_FILE)
    }
  } catch {}
}

// 3. Skip onboarding when API key is provided
if (process.env.ANTHROPIC_API_KEY) {
  const claudeJson = join(HOME, '.claude.json')
  try {
    const content = readFileSync(claudeJson, 'utf8').trim()
    if (!content) throw new Error('empty')
  } catch {
    writeJSON(CONFIG_FILE, { hasCompletedOnboarding: true })
  }
}

// 4. Symlink project store into /workspace/.mrc/
try {
  let alreadyLinked = false
  try { alreadyLinked = lstatSync(PROJECT_STORE).isSymbolicLink() } catch {}

  if (!alreadyLinked) {
    mkdirSync(MRC_LOCAL, { recursive: true })
    mkdirSync(dirname(PROJECT_STORE), { recursive: true })
    if (existsSync(PROJECT_STORE)) {
      cpSync(PROJECT_STORE, MRC_LOCAL, { recursive: true })
      rmSync(PROJECT_STORE, { recursive: true, force: true })
    }
    symlinkSync(MRC_LOCAL, PROJECT_STORE)
  }
} catch (e) {
  console.error('Warning: project store symlink failed:', e.message)
}

// 5. Seed .gitignore entry for .mrc/
if (existsSync('/workspace/.git')) {
  const gitignore = '/workspace/.gitignore'
  try {
    const content = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
    if (!content.split('\n').includes('.mrc/')) {
      appendFileSync(gitignore, '.mrc/\n')
    }
  } catch {}
}

// 6. Configure notification hooks + default statusLine in a single pass
{
  const settings = readJSON(SETTINGS_FILE) || {}

  // Purge stale hook paths (e.g. old mrc-notify-hook.sh from previous versions).
  // Runs unconditionally so broken hooks are cleaned even when MRC_NOTIFY_PORT
  // isn't set in this session.
  const STALE_HOOK_SUFFIXES = ['/mrc-notify-hook.sh']
  if (settings.hooks) {
    for (const event of Object.keys(settings.hooks)) {
      settings.hooks[event] = (settings.hooks[event] || []).filter(entry =>
        !(entry.hooks || []).some(h =>
          STALE_HOOK_SUFFIXES.some(suffix => h.command?.endsWith(suffix))
        )
      )
      if (settings.hooks[event].length === 0) delete settings.hooks[event]
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
  }

  const notifyPort = process.env.MRC_NOTIFY_PORT
  if (notifyPort) {
    settings.hooks = settings.hooks || {}
    const hookEntry = [{
      matcher: '',
      hooks: [{ type: 'command', command: '/usr/local/bin/mrc-notify-hook.js' }],
    }]
    settings.hooks.Stop = hookEntry
    settings.hooks.PermissionRequest = hookEntry
    settings.hooks.Notification = hookEntry
  }

  const cmd = settings.statusLine?.command || ''
  const isStale = !cmd || cmd.endsWith('/mrc-statusline') || cmd.endsWith('/mrc-statusline.sh')
  if (!settings.statusLine || isStale) {
    settings.statusLine = {
      type: 'command',
      command: '/usr/local/bin/mrc-statusline.js',
      padding: 0,
    }
  }

  writeJSON(SETTINGS_FILE, settings)
}

// 7. Compute resume flag and write it for entrypoint.sh to read
const resumeSession = process.env.RESUME_SESSION || ''
const newSession = process.env.NEW_SESSION === '1'
let resumeFlag = ''

if (resumeSession) {
  resumeFlag = `--resume ${resumeSession}`
} else if (!newSession) {
  try {
    const jsonls = readdirSync(MRC_LOCAL).filter(f => f.endsWith('.jsonl'))
    if (jsonls.length > 0) resumeFlag = '--continue'
  } catch {}
}

// Write resume flag for entrypoint.sh to source
writeFileSync('/tmp/mrc-resume-flag', resumeFlag)

console.log('Container setup complete.')
