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

  if (content.includes('op://')) {
    dbg('.env contains op:// references, using 1Password CLI')
    return loadOpEnv(envFile)
  }

  // Simple .env parsing
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*(\w+)\s*=\s*"?([^"]*)"?\s*$/)
    if (match) process.env[match[1]] = match[2]
  }
  return process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null
}

function loadOpEnv(envFile) {
  const opAccount = process.env.OP_ACCOUNT || ''

  const tryOp = (account, key) => {
    const args = ['run', '--env-file', envFile, '--no-masking']
    if (account) args.push('--account', account)
    args.push('--', 'printenv', key)
    try {
      return execFileSync('op', args, { timeout: 5000, encoding: 'utf8' }).trim()
    } catch { return '' }
  }

  let accounts = null
  const getAccounts = () => {
    if (accounts !== null) return accounts
    if (opAccount) return accounts = []
    try {
      const json = execFileSync('op', ['account', 'list', '--format=json'], {
        timeout: 5000, encoding: 'utf8',
      })
      accounts = JSON.parse(json).map(a => a.url)
    } catch { accounts = [] }
    return accounts
  }

  for (const envKey of ['MRC_SESSION_NAMING_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
    let val = tryOp(opAccount, envKey)
    if (!val) {
      for (const acct of getAccounts()) {
        dbg(`trying op account: ${acct} for ${envKey}`)
        val = tryOp(acct, envKey)
        if (val) { dbg(`got ${envKey} from account: ${acct}`); break }
      }
    }
    if (val) {
      dbg(`got ${envKey} from op`)
      process.env[envKey] = val
    }
  }

  return process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null
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
