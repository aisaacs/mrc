// #49 (4b) — the container-lifetime SNI sidecar: client-auth (before peek/dial), the three-state liveness
// oracle, and the CORRECTED ensureSeal action table (refuse only on `alive`; respawn on a fresh port for both
// `dead` and `alive-wrong-secret`, which fixes the resume deadlock Pierre found). Driven against a REAL
// localhost proxy + real spawned seals — no Docker. (The container-death REAP + fails-closed-on-master-death
// are behavioral, verified on a rebuild.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { startSniProxy } from '../src/proxies/sni-proxy.js'
import { probeSeal, sealAliveForNonce, ensureSeal, writeSealPortfile, readSealPortfile, removeSealPortfile, sealPortfilePath, sealProcessAlive, reapSealForNonce, sealPidsForNonce, reconcileSealDecision } from '../src/proxies/seal.js'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const hasPgrep = () => !spawnSync('pgrep', ['-f', '__mrc_seal_probe__']).error

const portOf = (srv) => srv.address().port
const close = (srv) => new Promise((r) => srv.close(r))
const killQuiet = (pid) => { try { if (pid) process.kill(pid) } catch {} }

test('auth-before-peek: a wrong/absent Proxy-Authorization gets 407 and NEVER dials upstream (no probe oracle)', async () => {
  let dials = 0
  const proxy = await startSniProxy(0, { auth: 'TOKgood', dialUpstream: () => { dials++; return null } })
  try {
    // correct token → 200 (alive); no ClientHello sent → peek never completes → still no dial
    assert.equal(await probeSeal(portOf(proxy), 'TOKgood'), 'alive')
    // wrong token → 407 before peek/dial
    assert.equal(await probeSeal(portOf(proxy), 'TOKbad'), 'alive-wrong-secret')
    assert.equal(dials, 0, 'a 407 (and a probe) must never trigger an upstream dial')
  } finally { await close(proxy) }
})

test('probeSeal: three distinct states — alive (200) / alive-wrong-secret (407) / dead (refused)', async () => {
  const proxy = await startSniProxy(0, { auth: 'S', dialUpstream: () => null })
  try {
    assert.equal(await probeSeal(portOf(proxy), 'S'), 'alive')
    assert.equal(await probeSeal(portOf(proxy), 'WRONG'), 'alive-wrong-secret')
    // a port with nothing listening → connection refused → dead (fast, not a timeout)
    assert.equal(await probeSeal(1, 'S', 300), 'dead')
  } finally { await close(proxy) }
})

test('sealAliveForNonce: reads the portfile for the port, then probes with auth; no portfile → dead', async () => {
  const nonce = 'test-nonce-alive'
  const proxy = await startSniProxy(0, { auth: 'S', dialUpstream: () => null })
  try {
    removeSealPortfile(nonce)
    assert.equal(await sealAliveForNonce(nonce, 'S'), 'dead', 'no portfile → dead')
    writeSealPortfile(nonce, { port: portOf(proxy), pid: 1234, freshness: 'f1' })
    assert.equal(await sealAliveForNonce(nonce, 'S'), 'alive')
    assert.equal(await sealAliveForNonce(nonce, 'OTHER'), 'alive-wrong-secret', 'a foreign seal on the port 407s our secret')
  } finally { await close(proxy); removeSealPortfile(nonce) }
})

test('ensureSeal: spawns the detached seal, confirms bound via a live auth handshake, and is idempotent', async () => {
  const nonce = 'test-ensure-happy'
  removeSealPortfile(nonce)
  let pid
  try {
    const r = await ensureSeal({ nonce, secret: 'TOK', freshness: 'fr1', portBase: 9550, readyTimeoutMs: 6000 })
    assert.ok(r.ok, `ensureSeal ok: ${r.error || ''}`)
    pid = r.pid
    assert.ok(existsSync(sealPortfilePath(nonce)), 'portfile written after bind')
    assert.equal(await probeSeal(r.port, 'TOK'), 'alive', 'the spawned seal authenticates the token')
    // idempotent: a second call finds it alive and reuses it (no double-spawn)
    const again = await ensureSeal({ nonce, secret: 'TOK', freshness: 'fr1', portBase: 9550 })
    assert.ok(again.ok && again.already, 'second ensureSeal reuses the live seal')
    assert.equal(again.port, r.port)
  } finally { killQuiet(pid); removeSealPortfile(nonce) }
})

test('ensureSeal action table (the fix): alive-wrong-secret → respawn on a FRESH port, never deadlock', async () => {
  // Simulate the port-recycle-on-resume race: a STALE portfile points at a port now owned by a FOREIGN seal
  // (different token). ensureSeal must NOT refuse (the old bug = resume deadlock) — it must clean + respawn on
  // a fresh port with OUR token, and return that new port (≠ the foreign one).
  const nonce = 'test-ensure-wrongsecret'
  const foreign = await startSniProxy(0, { auth: 'FOREIGN', dialUpstream: () => null })
  let pid
  try {
    writeSealPortfile(nonce, { port: portOf(foreign), pid: 999999, freshness: 'stale' })
    assert.equal(await sealAliveForNonce(nonce, 'MINE'), 'alive-wrong-secret', 'the stale portfile 407s our token')
    const r = await ensureSeal({ nonce, secret: 'MINE', freshness: 'fresh', portBase: 9600, readyTimeoutMs: 6000 })
    assert.ok(r.ok, `respawned instead of deadlocking: ${r.error || ''}`)
    pid = r.pid
    assert.notEqual(r.port, portOf(foreign), 'respawned on a FRESH port, not the foreign one')
    assert.equal(await probeSeal(r.port, 'MINE'), 'alive', 'the fresh seal authenticates OUR token')
    // the portfile now reflects the fresh launch (new freshness), not the stale one
    assert.equal(readSealPortfile(nonce).freshness, 'fresh')
  } finally { killQuiet(pid); await close(foreign); removeSealPortfile(nonce) }
})

// --- reconcileSealDecision: pure, runs everywhere (no pgrep/docker) ---------
const alwaysAlive = () => true
const neverAlive = () => false
const neverGrace = () => false
const alwaysGrace = () => true

test('reconcile: zombie kill — container up + seal dead + PAST grace → kill the container', () => {
  const r = reconcileSealDecision({ liveSealNonces: new Set(['N1']), allSealNonces: [], sealAlive: neverAlive, withinGrace: neverGrace })
  assert.deepEqual(r.killContainers, ['N1'])
  assert.deepEqual(r.reapSeals, [])
})

test('reconcile: fail-toward-starting — container up + seal dead but WITHIN grace → do NOT kill (Strike B)', () => {
  const r = reconcileSealDecision({ liveSealNonces: new Set(['N1']), allSealNonces: [], sealAlive: neverAlive, withinGrace: alwaysGrace })
  assert.deepEqual(r.killContainers, [], 'a booting seal (not yet pgrep-visible) must not get its healthy container killed')
})

test('reconcile: healthy sealed container (container up + seal alive) → no kill, no reap', () => {
  const r = reconcileSealDecision({ liveSealNonces: new Set(['N1']), allSealNonces: ['N1'], sealAlive: alwaysAlive, withinGrace: neverGrace })
  assert.deepEqual(r.killContainers, [])
  assert.deepEqual(r.reapSeals, [])
})

test('reconcile: orphan reap — seal alive but NO live container carries the nonce → reap it', () => {
  const r = reconcileSealDecision({ liveSealNonces: new Set([]), allSealNonces: ['N1'], sealAlive: alwaysAlive, withinGrace: neverGrace })
  assert.deepEqual(r.reapSeals, ['N1'])
})

test('reconcile: Strike A — a RESUME reusing the nonce keeps its seal (re-check container-label at decision time)', () => {
  // The seal for N1 is alive AND a live container carries label mrc.seal=N1 (the resume, reusing the nonce).
  // Even though an earlier observation "saw N1's old container die", the decision re-reads live containers →
  // N1 is in service → NOT reaped. This is the fix for reaping a resume's fresh (or reused) seal.
  const r = reconcileSealDecision({ liveSealNonces: new Set(['N1']), allSealNonces: ['N1'], sealAlive: alwaysAlive, withinGrace: neverGrace })
  assert.deepEqual(r.reapSeals, [], 'a nonce still carried by a live container is never reaped, stale death-observation notwithstanding')
})

test('reap: kills the sidecar by pgrep-nonce, NEVER the stored pf.pid (drift + pid-reuse safe, #41 at the kill step)', async (t) => {
  if (!hasPgrep()) return t.skip('pgrep not available (procps)')
  const nonce = 'test-reap-nonce'
  removeSealPortfile(nonce)
  const r = await ensureSeal({ nonce, secret: 'TOK', freshness: 'fr', portBase: 9650, readyTimeoutMs: 6000 })
  assert.ok(r.ok, `spawned: ${r.error || ''}`)
  try {
    assert.ok(sealProcessAlive(nonce), 'the spawned seal is found by pgrep-nonce (cmdline match, not a stored pid)')
    // Corrupt the portfile pid to a bogus value: the reap must STILL kill the REAL process (matched by nonce),
    // proving it never trusts pf.pid — a recycled/stale pid would otherwise mis-kill or miss the real seal.
    writeSealPortfile(nonce, { ...readSealPortfile(nonce), pid: 999999 })
    reapSealForNonce(nonce)
    await new Promise((res) => setTimeout(res, 400))
    assert.ok(!sealProcessAlive(nonce), 'reap killed the real seal by nonce, despite the bogus pf.pid')
    assert.ok(!existsSync(sealPortfilePath(nonce)), 'portfile removed by the reap')
  } finally { for (const p of sealPidsForNonce(nonce)) killQuiet(Number(p)); removeSealPortfile(nonce) }
})
