import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { dbg } from './output.js'

// #34: split a .mrcrc flag LINE into argv tokens (quote-aware) so `--colima-memory 32` becomes
// ['--colima-memory','32'] instead of one un-parseable arg that silently falls through. Honors '…'/"…"
// for a value with spaces (e.g. `--new "my session"`); an unterminated quote just takes the rest of the line.
export function tokenizeArgs(line) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/** Parse a .mrcrc file into flag TOKENS (#34: lines are tokenized) and env vars (KEY=VALUE lines, kept whole). */
export function readMrcrc(file) {
  if (!existsSync(file)) return { flags: [], envs: [] }
  const flags = []
  const envs = []
  for (let line of readFileSync(file, 'utf8').split('\n')) {
    line = line.replace(/#.*$/, '').trim()
    if (!line) continue
    if (/^[A-Z_]+=/.test(line)) envs.push(line)            // KEY=VALUE env line — value may contain spaces, keep whole
    else flags.push(...tokenizeArgs(line))                 // #34: tokenize so a multi-token flag line actually parses
  }
  return { flags, envs }
}

// --- Belt 0 (security): <repo>/.mrcrc is the bind-mounted, sandbox-WRITABLE workspace, so a contained
// session can write to it to escalate its OWN next launch. It is therefore the LEAST-trusted config
// source and gets an ALLOWLIST (deny-by-default) — NOT a denylist, which fails open on the next
// flag/env nobody remembered to add (that bug bit twice: a missing MRC_ADVERSARY let a contained
// adversary self-declassify; a missing --room let a repo force-pair cloners into a room). The trusted
// surfaces — CLI argv and host-only ~/.mrcrc — are UNRESTRICTED; only the repo file is filtered.
//
// FLAGS — a repo .mrcrc may set ONLY these local-UX flags; EVERYTHING else (incl. any flag added later)
// is denied and must come from argv or ~/.mrcrc. Adding a flag here requires the same threat-review.
// Denied by NOT being listed: egress/containment/trust (-w/--web, --room, --rooms, --agent,
// --summoned-by, --open-adversary-unsafe), host-global resource (--colima-*, -r/--rebuild), mode
// (--daemon, -j/--json), and CLI-hijack (the `--` separator, -h/--help).
//
// NOTE: this is a per-TOKEN filter, and #34 makes repo lines tokenize, so a value-flag's value token (e.g.
// 'myname' after `--new`) is itself checked and dropped (not an allowed flag) AND a second flag on one line
// (e.g. `--no-sound --web`) is filtered independently — so a repo file CANNOT smuggle `--web` past an allowed
// leading flag. Fine today: the only allowed value-flag is --new and losing its OPTIONAL name is safe-direction
// (a repo can force a fresh session but never a misleading NAME). A value-REQUIRED repo flag would need a
// value-aware filter, not this one.
const REPO_ALLOWED_FLAGS = new Set([
  '--no-sound', '--no-notify', '--no-summary', '--no-rooms', '--verbose', '-v', '--new', '-n',
])
// ENVS — mrc's own control surface is reserved from the repo file: ALLOW_WEB and any MRC_* env (all of
// which are host-SET or host-READ; none is legitimately repo-sourced). Everything else passes through —
// a repo legitimately needs arbitrary non-mrc envs (app config), so this is a namespace-RESERVE, NOT a
// closed allowlist like the flags. INVARIANT (or the next env re-opens the class a denylist would):
// every new containment/egress env MUST be MRC_-prefixed (auto-covered here) OR added to this check like
// the lone non-prefixed exception ALLOW_WEB. (The flag side has no such residual — deny-by-default
// already covers any future flag; only the env reserve carries this one convention.)
const repoEnvForbidden = (key) => key === 'ALLOW_WEB' || key.startsWith('MRC_')

/**
 * Belt 0: filter a repo .mrcrc's parsed flags/envs down to the safe allowlist. PURE — `warn(msg)` is
 * called once per dropped entry so the caller owns the notice. Returns { flags, envs }.
 */
export function sanitizeRepoConfig(repoFlags, repoEnvs, warn = () => {}) {
  const flags = repoFlags.filter((f) => {
    if (REPO_ALLOWED_FLAGS.has(f)) return true
    // f is a single token (#34: readMrcrc tokenizes). Warn only for a disallowed FLAG; silently drop an
    // orphaned VALUE token (e.g. the name after a repo `--new`) so the notice stays about flags, not values.
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

/** Load .env file, handling 1Password op:// references. Returns the API key or null. */
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
    if (skipOp) { dbg('skipping op:// resolution (summoned session needs no naming key — no biometric)'); return null }
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
      case '-n': case '--new':
        config.newSession = true
        // #26/#48: take the next token as the session NAME only if it isn't the REPO PATH. Without the
        // existsSync guard, `mrc --new ~/repo` (or `mrc --new .`) ate the repo as a garbage name — which set
        // the wrong repo AND disabled the auto-namer (a truthy newSessionName gates the watcher off), so the
        // session showed its repo basename forever (and read as "inherited" a same-repo peer's name, #48).
        // A name that happens to match an existing path is treated as the repo; use `mrc <repo> --new <name>`
        // to name unambiguously. (Shell-expanded ~ means existsSync sees a real path here.)
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
      case '--summoned-by':   // internal (daemon-set): pair this session with the summoner once it registers
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) config.summonedBy = argv[++i]
        break
      case '--open-adversary-unsafe': config.openAdversaryUnsafe = true; break   // reopen a summoned adversary WITHOUT its cage (full egress) — deliberate; belt 0 blocks it from repo .mrcrc
      default: remaining.push(arg)
    }
  }
  return { config, remaining, claudeArgs, help }
}
