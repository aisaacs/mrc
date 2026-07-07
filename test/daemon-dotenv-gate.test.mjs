// Follow-up #2 coverage — proves the daemon-boot .env/op gate (maybeLoadDaemonEnv) actually gates, driving the REAL
// exported function with a scriptDir we control (a real daemon's scriptDir is hardcoded to the repo root, so a spawn
// test can't reproduce the trigger — and in a sandbox /workspace/.env may be masked to /dev/null, shadowing it). Here
// the scriptDir's .env carries an op:// ref + a recording stub `op` is on PATH; the gate must:
//   - WITHOUT MRC_DAEMON_SKIP_DOTENV → load .env (op:// → op) so production media members still get keys → op consulted
//   - WITH    MRC_DAEMON_SKIP_DOTENV → skip entirely → op NEVER consulted (no Touch ID, no suite hang)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { maybeLoadDaemonEnv } from '../src/proxies/room-daemon.js'

async function loadWith({ skip }) {
  const saved = { ...process.env }
  const dir = mkdtempSync(join(os.tmpdir(), 'mrc-dgate-'))
  try {
    const scriptDir = join(dir, 'repo'); mkdirSync(scriptDir, { recursive: true })
    writeFileSync(join(scriptDir, '.env'), 'MRC_SESSION_NAMING_ANTHROPIC_API_KEY=op://vault/item/field\n')
    const home = join(dir, 'home'); mkdirSync(join(home, '.config', 'mrc'), { recursive: true })   // isolate: no real ~/.config/mrc/.env
    const bin = join(dir, 'bin'); mkdirSync(bin)
    const flag = join(dir, 'op-invoked')
    writeFileSync(join(bin, 'op'), `#!/usr/bin/env bash\ntouch ${JSON.stringify(flag)}\ncase "$1" in account) echo '[]';; *) exit 1;; esac\n`)
    chmodSync(join(bin, 'op'), 0o755)
    for (const k of ['MRC_SESSION_NAMING_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OP_ACCOUNT', 'MRC_DAEMON_SKIP_DOTENV']) delete process.env[k]
    process.env.HOME = home
    process.env.PATH = `${bin}:${process.env.PATH}`
    if (skip) process.env.MRC_DAEMON_SKIP_DOTENV = '1'
    const res = await maybeLoadDaemonEnv(scriptDir)
    return { loaded: res.loaded, opInvoked: existsSync(flag) }
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, saved)
    rmSync(dir, { recursive: true, force: true })
  }
}

test('daemon boot WITHOUT the flag → loads .env, op IS consulted (production media keys still resolve)', async () => {
  const { loaded, opInvoked } = await loadWith({ skip: false })
  assert.equal(loaded, true, 'unset flag: boot loads .env as before')
  assert.equal(opInvoked, true, 'an op:// .env is resolved via op')
})

test('daemon boot WITH MRC_DAEMON_SKIP_DOTENV=1 → skips entirely, op NEVER consulted (hermetic-spawn guarantee)', async () => {
  const { loaded, opInvoked } = await loadWith({ skip: true })
  assert.equal(loaded, false, 'the gate short-circuits before any .env read')
  assert.equal(opInvoked, false, 'no .env → no op → no Touch ID, no hang')
})
