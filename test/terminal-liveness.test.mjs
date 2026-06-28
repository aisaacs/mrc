// #41: lock the ttydAlive/sessionAlive DURABILITY invariant in-suite. classifyTerminal's `serve` branch
// and ttydAlive's "match the ttyd PROCESS cmdline, not a browser connection" property are otherwise only
// hit on the host path (no real dtach in the unit suite), so a regression to connection-gated liveness
// would silently reintroduce mass-false-orphaned with green tests. Here we spawn throwaway processes whose
// cmdline contains `dtach -n <sock>` (master) and `dtach -a <sock>` (viewer) and assert serve — no browser,
// no real dtach/ttyd, no real container (containerAlive is a passed fact).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, writeFileSync as touch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyTerminal } from '../src/commands/team.js'

const havePgrep = () => { try { execFileSync('pgrep', ['-f', 'definitely-no-such-process-xyz'], { stdio: 'ignore' }) } catch (e) { return e.status === 1 } ; return true }

test('terminal serve requires a DURABLE dtach -a viewer process, not a browser connection (#41)', { skip: !havePgrep() && 'pgrep unavailable' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrc-livetest-'))
  const sock = join(dir, 'org-handle.dtach')
  // a dummy "dtach" executable that just sleeps WITHOUT exec, so its cmdline `<dir>/dtach <flag> <sock>`
  // persists for pgrep to match (an `exec sleep` would replace the cmdline and defeat the test).
  const dummy = join(dir, 'dtach')
  writeFileSync(dummy, '#!/bin/sh\nsleep 30\n'); chmodSync(dummy, 0o755)
  const procs = []
  try {
    touch(sock, '')                                                   // the socket FILE (sessionAlive checks existsSync)
    procs.push(spawn(dummy, ['-n', sock, '-E', '-r', 'winch'], { stdio: 'ignore' }))   // master  (dtach -n <sock>)
    procs.push(spawn(dummy, ['-a', sock, '-E', '-r', 'winch'], { stdio: 'ignore' }))   // viewer  (dtach -a <sock>)
    await new Promise((r) => setTimeout(r, 250))                      // let them appear to pgrep
    const info = { sock, ttydPort: 7681 }
    // master + socket + viewer all live + container fact true → serve. No browser is attached anywhere.
    assert.equal(classifyTerminal(info, { containerAlive: true, online: false, withinGrace: true }), 'serve')
    // kill ONLY the viewer (-a) → not servable → with online it's orphaned (the dead-viewer case)
    procs[1].kill('SIGKILL'); await new Promise((r) => setTimeout(r, 250))
    assert.equal(classifyTerminal(info, { containerAlive: true, online: true, withinGrace: true }), 'orphaned')
  } finally {
    for (const p of procs) { try { p.kill('SIGKILL') } catch {} }
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})
