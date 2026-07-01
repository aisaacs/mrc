import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { dbg } from './output.js'

/** Parse a .mrcrc file into flags and env vars (KEY=VALUE lines). */
export function readMrcrc(file) {
  if (!existsSync(file)) return { flags: [], envs: [] }
  const flags = []
  const envs = []
  for (let line of readFileSync(file, 'utf8').split('\n')) {
    line = line.replace(/#.*$/, '').trim()
    if (!line) continue
    if (/^[A-Z_]+=/.test(line)) envs.push(line)
    else flags.push(line)
  }
  return { flags, envs }
}

/** Load .env file, handling 1Password op:// references. Returns the API key or null. */
export function loadEnv(scriptDir) {
  const candidates = [
    join(scriptDir, '.env'),
    join(process.env.HOME || '/root', '.config', 'mrc', '.env'),
  ]
  const envFile = candidates.find(f => existsSync(f))
  if (!envFile) return null

  dbg(`loading .env from ${envFile}`)
  const content = readFileSync(envFile, 'utf8')

  // Load plain KEY=VALUE lines first (so OP_ACCOUNT, MRC_PORT_BASE, etc. take effect even when the
  // file also contains op:// references). Values that ARE op:// references are left for the op CLI.
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*(\w+)\s*=\s*"?([^"]*)"?\s*$/)
    if (match && !match[2].includes('op://')) process.env[match[1]] = match[2]
  }

  if (content.includes('op://')) {
    dbg('.env contains op:// references, using 1Password CLI')
    return loadOpEnv(envFile)
  }

  return process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null
}

function loadOpEnv(envFile) {
  const keys = ['MRC_SESSION_NAMING_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']

  // Resolve ALL op:// references in ONE `op run` per account (not once per key — that multiplied
  // the biometric prompts), capturing the keys we care about. Stderr is dropped so a "vault not in
  // this account" miss stays quiet instead of spamming [ERROR] lines.
  const runFor = (account) => {
    const args = ['run', '--env-file', envFile, '--no-masking']
    if (account) args.push('--account', account)
    args.push('--', 'sh', '-c', keys.map(k => `printf '%s\\n' "$${k}"`).join('; '))
    try {
      const out = execFileSync('op', args, { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const lines = out.split('\n')
      const got = {}
      keys.forEach((k, i) => { const v = (lines[i] || '').trim(); if (v) got[k] = v })
      return got
    } catch { return {} }
  }

  // Scope to one account when possible (OP_ACCOUNT, from the shell or the .env) — this avoids
  // biometric-prompting (and erroring on) accounts that don't hold the referenced vault. Otherwise
  // try each configured account in turn and stop at the first that resolves a secret.
  for (const acct of opAccountCandidates()) {
    const got = runFor(acct)
    if (Object.keys(got).length) {
      for (const [k, v] of Object.entries(got)) process.env[k] = v
      dbg(`got op secrets from account: ${acct || '(default)'}`)
      break
    }
  }

  return process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null
}

/** 1Password accounts to try, in order: an explicit OP_ACCOUNT, else every configured account
 *  (so a secret in any of them resolves), else the default (''). Shared by the .env and .mrcrc
 *  op:// resolvers. */
function opAccountCandidates() {
  const opAccount = process.env.OP_ACCOUNT || ''
  if (opAccount) return [opAccount]
  try {
    const json = execFileSync('op', ['account', 'list', '--format=json'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const accts = JSON.parse(json).map(a => a.url).filter(Boolean)
    return accts.length ? accts : ['']
  } catch { return [''] }
}

/** Resolve a single op:// secret reference, trying each candidate account. Returns the secret or null. */
function opRead(ref) {
  for (const acct of opAccountCandidates()) {
    try {
      const args = ['read', '--no-newline']
      if (acct) args.push('--account', acct)
      args.push(ref)
      const out = execFileSync('op', args, { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      if (out && out.trim()) return out.trim()
    } catch {}
  }
  return null
}

/** If a .mrcrc env line's value is an op:// reference, resolve it via 1Password (host-side) and
 *  return { key, value }; otherwise return null (the caller injects the line verbatim). Resolving
 *  here — per project, from <repo>/.mrcrc — keeps the secret out of mrc's global config and out of
 *  the container image; the sandbox has no op CLI and the firewall blocks 1Password anyway. */
export function resolveOpEnv(entry) {
  const eq = entry.indexOf('=')
  if (eq < 0) return null
  const key = entry.slice(0, eq)
  const ref = entry.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
  if (!ref.startsWith('op://')) return null
  const value = opRead(ref)
  if (!value) {
    console.error(`  ⚠ 1Password couldn't resolve ${key} (${ref}); injecting the reference unresolved.`)
    return null
  }
  dbg(`resolved op:// reference for ${key}`)
  return { key, value }
}

/** Parse CLI args into a config object. Returns { config, repoArgs, claudeArgs }. */
export function parseArgs(argv) {
  const config = {
    verbose: false,
    allowWeb: false,
    daemon: false,
    newSession: false,
    newSessionName: '',
    json: false,
    noNotify: false,
    noSound: false,
    noSummary: false,
    rebuild: false,
    colimaCpu: '',
    colimaMemory: '',
    resumeSession: '',
    agent: 'claude',
    room: '',
    rooms: true,   // cross-session negotiation rooms are ON by default (disable with --no-rooms)
  }
  const remaining = []
  const claudeArgs = []
  let seenSeparator = false
  let help = false

  for (let i = 0; i < argv.length; i++) {
    if (seenSeparator) { claudeArgs.push(argv[i]); continue }
    const arg = argv[i]
    switch (arg) {
      case '--': seenSeparator = true; break
      case '-h': case '--help': help = true; break
      case '-n': case '--new':
        config.newSession = true
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.newSessionName = argv[++i]
        break
      case '--no-notify': config.noNotify = true; break
      case '--no-sound': config.noSound = true; break
      case '--no-summary': config.noSummary = true; break
      case '-r': case '--rebuild': config.rebuild = true; break
      case '-v': case '--verbose': config.verbose = true; break
      case '--daemon': config.daemon = true; break
      case '-j': case '--json': config.json = true; break
      case '-w': case '--web': config.allowWeb = true; break
      case '--colima-cpu':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.colimaCpu = argv[++i]
        break
      case '--colima-memory':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.colimaMemory = argv[++i]
        break
      case '--agent':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.agent = argv[++i]
        break
      case '--room':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.room = argv[++i]
        break
      case '--rooms': config.rooms = true; break
      case '--no-rooms': config.rooms = false; break
      default: remaining.push(arg)
    }
  }
  return { config, remaining, claudeArgs, help }
}
