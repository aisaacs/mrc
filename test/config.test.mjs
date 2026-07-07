// Hermetic tests for src/config.js loadEnv() — the 1Password op:// resolution path. These assert the LOGIC
// (resolve / skipOp / graceful-degrade) with a fixture .env + a STUB `op` on PATH, so they NEVER touch the
// developer's real vault (no Touch ID, no "no accounts configured" hang). This is the coverage that lets the op
// path be tested without depending on live 1Password — the integration itself is exercised by normal `mrc` use.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { loadEnv } from '../src/config.js'

// Run loadEnv fully isolated: a temp scriptDir (+ optional .env), an isolated HOME (so the real ~/.config/mrc/.env
// is never picked up), and — when opStub is given — a stub `op` on PATH that records whether it was invoked. The
// full process.env is saved and restored around every call (loadEnv sets keys + reads HOME/PATH/OP_ACCOUNT).
function hermeticLoadEnv({ dotenv = null, skipOp = false, opStub = null, opAccount = null }) {
  const saved = { ...process.env }
  const dir = mkdtempSync(join(os.tmpdir(), 'mrc-cfg-'))
  try {
    const home = join(dir, 'home'); mkdirSync(join(home, '.config', 'mrc'), { recursive: true })
    const scriptDir = join(dir, 'script'); mkdirSync(scriptDir, { recursive: true })
    if (dotenv != null) writeFileSync(join(scriptDir, '.env'), dotenv)
    for (const k of ['MRC_SESSION_NAMING_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OP_ACCOUNT']) delete process.env[k]
    process.env.HOME = home
    if (opAccount) process.env.OP_ACCOUNT = opAccount
    const flag = join(dir, 'op-invoked')
    if (opStub) {
      const bin = join(dir, 'bin'); mkdirSync(bin)
      writeFileSync(join(bin, 'op'), opStub(flag)); chmodSync(join(bin, 'op'), 0o755)
      process.env.PATH = `${bin}:${process.env.PATH}`
    }
    const result = loadEnv(scriptDir, { skipOp })
    return { result, opInvoked: existsSync(flag) }
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
}

// A stub that resolves: `op account list` returns one account; `op run` prints the 3 keys (naming, anthropic, openai)
// in loadOpEnv's expected order — first one populated, rest empty. Touches `flag` so we can assert op WAS consulted.
const OP_RESOLVING = (flag) => `#!/usr/bin/env bash
touch ${JSON.stringify(flag)}
case "$1" in
  account) echo '[{"url":"stub.1password.com"}]';;
  run) printf 'STUB-NAMING-KEY\\n\\n\\n';;
  *) exit 1;;
esac
`
// A stub that fails every call (op present but broken / locked) — loadEnv must degrade, never throw.
const OP_FAILING = (flag) => `#!/usr/bin/env bash
touch ${JSON.stringify(flag)}
exit 1
`
const OPKEY = 'MRC_SESSION_NAMING_ANTHROPIC_API_KEY=op://vault/item/field\n'

test('loadEnv: no .env anywhere → null, op never consulted', () => {
  const { result, opInvoked } = hermeticLoadEnv({ dotenv: null, opStub: OP_RESOLVING })
  assert.equal(result, null)
  assert.equal(opInvoked, false)
})

test('loadEnv: plain-value .env (no op://) → returns the naming key directly, op untouched', () => {
  const { result, opInvoked } = hermeticLoadEnv({ dotenv: 'MRC_SESSION_NAMING_ANTHROPIC_API_KEY=sk-plain\n', opStub: OP_RESOLVING })
  assert.equal(result, 'sk-plain')
  assert.equal(opInvoked, false, 'a plain .env needs no op — no biometric on a keyed-but-not-op:// config')
})

test('loadEnv: op:// .env + skipOp → null and op is NEVER invoked (the summoned-adversary / hermetic guarantee)', () => {
  const { result, opInvoked } = hermeticLoadEnv({ dotenv: OPKEY, skipOp: true, opStub: OP_RESOLVING })
  assert.equal(result, null)
  assert.equal(opInvoked, false, 'skipOp must short-circuit BEFORE shelling out to op — no Touch ID, no hang')
})

test('loadEnv: op:// .env + !skipOp → resolves via op and returns the key', () => {
  const { result, opInvoked } = hermeticLoadEnv({ dotenv: OPKEY, skipOp: false, opStub: OP_RESOLVING })
  assert.equal(result, 'STUB-NAMING-KEY')
  assert.equal(opInvoked, true, 'the resolve branch actually shells out to op')
})

test('loadEnv: op:// .env + op FAILS → degrades to null gracefully, never throws', () => {
  let out
  assert.doesNotThrow(() => { out = hermeticLoadEnv({ dotenv: OPKEY, opStub: OP_FAILING }) })
  assert.equal(out.result, null)
  assert.equal(out.opInvoked, true, 'op was tried, its failure was swallowed (no naming key is non-fatal)')
})

test('loadEnv: OP_ACCOUNT set → skips `op account list`, still resolves via that account', () => {
  const { result } = hermeticLoadEnv({ dotenv: OPKEY, opAccount: 'me.1password.com', opStub: OP_RESOLVING })
  assert.equal(result, 'STUB-NAMING-KEY')
})
