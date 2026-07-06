import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { dbg } from './output.js'

/** Parse a .mrcrc file into flags and env vars (KEY=VALUE lines). */
// #34: quote-aware whitespace tokenizer so a multi-token .mrcrc flag LINE parses as separate argv tokens.
export function tokenizeArgs(line) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export function readMrcrc(file) {
  if (!existsSync(file)) return { flags: [], envs: [] }
  const flags = []
  const envs = []
  for (let line of readFileSync(file, 'utf8').split('\n')) {
    line = line.replace(/#.*$/, '').trim()
    if (!line) continue
    if (/^[A-Z_]+=/.test(line)) envs.push(line)               // KEY=VALUE env line — value may contain spaces, keep whole
    else flags.push(...tokenizeArgs(line))                    // #34: tokenize — `--colima-memory 32` (a documented .mrcrc line) now parses as the flag + its value, not one dead arg. Also makes belt-0's per-token filter claim TRUE.
  }
  return { flags, envs }
}

// Belt 0: a <repo>/.mrcrc is SANDBOX-WRITABLE (it lives in the bind-mounted repo), so a contained session
// could write egress/containment flags into it to self-escalate its NEXT launch. Deny-by-default: only
// local-UX flags are honored from the repo file; egress/containment/mode/CLI-hijack flags are dropped.
// Per-TOKEN filter (readMrcrc tokenizes), so a value-flag's value token and a second flag on one line are
// each checked — a repo file can't smuggle `--web` past an allowed leading flag.
const REPO_ALLOWED_FLAGS = new Set([
  '--no-sound', '--no-notify', '--no-summary', '--no-rooms', '--verbose', '-v', '--new', '-n',
])
// ENVS: mrc's own control surface is RESERVED from the repo file — ALLOW_WEB and any MRC_* env (host-set or
// host-read; never legitimately repo-sourced). Everything else passes (a repo needs arbitrary app envs).
// INVARIANT: every new containment/egress env MUST be MRC_-prefixed (auto-covered) or added here like ALLOW_WEB.
const repoEnvForbidden = (key) => key === 'ALLOW_WEB' || key.startsWith('MRC_')

/**
 * Belt 0: filter a repo .mrcrc's parsed flags/envs down to the safe allowlist. PURE — `warn(msg)` is
 * called once per dropped entry so the caller owns the notice. Returns { flags, envs }.
 */
export function sanitizeRepoConfig(repoFlags, repoEnvs, warn = () => {}) {
  const flags = repoFlags.filter((f) => {
    if (REPO_ALLOWED_FLAGS.has(f)) return true
    // Warn only for a disallowed FLAG; silently drop an orphaned VALUE token (e.g. the name after a repo
    // `--new`) so the notice stays about flags, not values.
    if (f.startsWith('-')) warn(`flag "${f}" from <repo>/.mrcrc — only local-UX flags are honored there; egress/containment/mode flags come from the CLI or ~/.mrcrc`)
    return false
  })
  const envs = repoEnvs.filter((e) => {
    if (!repoEnvForbidden(e.split('=')[0])) return true
    warn(`env "${e.split('=')[0]}" from <repo>/.mrcrc — MRC_* and ALLOW_WEB are reserved (host-only control surface); set them via the CLI or ~/.mrcrc`)
    return false
  })
  return { flags, envs }
}

/** Load .env file, handling 1Password op:// references. Returns the API key or null.
 *  skipOp: don't resolve op:// references (skips the 1Password CLI / Touch ID prompt). A summoned adversary
 *  is deterministically named "Pierre" and needs no host naming key, so it must never trigger a biometric. */
export function loadEnv(scriptDir, { skipOp = false } = {}) {
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
    if (skipOp) { dbg('skipping op:// resolution (summoned session is deterministically named — no naming key, no biometric prompt)'); return null }
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
  const opAccount = process.env.OP_ACCOUNT || ''
  let candidates = [opAccount]
  if (!opAccount) {
    try {
      const json = execFileSync('op', ['account', 'list', '--format=json'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      const accts = JSON.parse(json).map(a => a.url).filter(Boolean)
      candidates = accts.length ? accts : ['']
    } catch { candidates = [''] }
  }

  for (const acct of candidates) {
    const got = runFor(acct)
    if (Object.keys(got).length) {
      for (const [k, v] of Object.entries(got)) process.env[k] = v
      dbg(`got op secrets from account: ${acct || '(default)'}`)
      break
    }
  }

  return process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || null
}

/** Resolve an API key for a member's REPO: prefer the repo's own .env (or .mrc/.env), then fall back
 *  to the process env (the global mrc .env the daemon loaded). So a project's character keys
 *  (GEMINI_API_KEY, ELEVEN_LABS_API_KEY, OPENAI_API_KEY) live with the repo when present. op://
 *  references are skipped here (the global loadEnv resolves those into process.env). */
export function repoEnvKey(repo, name) {
  if (repo) {
    for (const f of [join(repo, '.env'), join(repo, '.mrc', '.env')]) {
      try {
        for (const line of readFileSync(f, 'utf8').split('\n')) {
          const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
          if (m && m[1] === name) { const v = m[2].trim(); if (v && !v.includes('op://')) return v }
        }
      } catch {}
    }
  }
  return process.env[name] || ''
}

/** Like repoEnvKey but STRICT: reads ONLY the repo's own .env / .mrc/.env — NO process.env fallback.
 *  For PER-PROJECT secrets that must never bleed from the daemon's global env. Critically the Telegram
 *  bot token: the daemon may run inside an mrc that loaded mrc's .env into process.env, and the
 *  fallback would then hand that one bot to EVERY token-less project (misattributing /start to the
 *  wrong project). A global bot token is meaningless for per-project bots, so there is no fallback. */
export function repoEnvKeyStrict(repo, name) {
  if (!repo) return ''
  for (const f of [join(repo, '.env'), join(repo, '.mrc', '.env')]) {
    try {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/)
        if (m && m[1] === name) { const v = m[2].trim(); if (v && !v.includes('op://')) return v }
      }
    } catch {}
  }
  return ''
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
    member: '',    // team-member launch: this session is @member from the roster
    solo: false,   // #49: solo onramp — register this plain session as a derived team-of-one engine member
    roster: '',    // path to team.json (for --member launches)
    memberDef: '', // #49-SEC: base64(json) of the OUTER launcher's already-resolved, already-authorized member
                   // def (+ its team org). The inner --member launch derives EVERY security-load-bearing field
                   // (org→sessionId, mount/territory→write-scope, repo, cage) from THIS host-set argv — which the
                   // member CONTAINER cannot tamper — NOT from the member-writable roster (team.runtime.json in
                   // the rw .mrc mount). The roster survives only as display context (persona teammates).
    summonedBy: '', // internal: stamped by the daemon's summon launcher so a spawned adversary auto-pairs with its summoner
    openAdversaryUnsafe: false, // --open-adversary-unsafe: reopen a summoned adversary UNCAGED (full egress). Loud + deliberate; belt 0 keeps it argv/~/.mrcrc-only (never repo .mrcrc).
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
      // L2/#26: `!existsSync` so `mrc --new ~/repo` / `mrc --new .` doesn't eat the repo PATH as a session name
      // (a truthy name also gates the auto-namer OFF → the #48 inherited-name regression).
      case '-n': case '--new':
        config.newSession = true
        if (argv[i + 1] && !argv[i + 1].startsWith('-') && !existsSync(argv[i + 1])) config.newSessionName = argv[++i]
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
      case '--solo': config.solo = true; break   // #49: derive a team-of-one personal org, no team.json
      case '--member':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.member = argv[++i]
        break
      case '--roster':
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.roster = argv[++i]
        break
      case '--member-def':   // #49-SEC: host-set authoritative member blob (base64 json); never container-tamperable
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.memberDef = argv[++i]
        break
      case '--summoned-by':   // internal (daemon-set): pair this session with the summoner once it registers
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.summonedBy = argv[++i]
        break
      case '--open-adversary-unsafe': config.openAdversaryUnsafe = true; break   // reopen a summoned adversary WITHOUT its cage (full egress) — deliberate; belt 0 blocks it from repo .mrcrc
      default: remaining.push(arg)
    }
  }
  return { config, remaining, claudeArgs, help }
}
