// countAgentPeers gates the auto-new-session force in mrc.js.
//
// The bug it fixes: that force counted EVERY running mrc container in the repo, so an open Claude session
// made `mrc --agent codex` silently start fresh — auto-resume looked broken while `mrc pick --agent codex`
// worked, because pick sets resumeSession explicitly and bypasses the force. Two sessions of the SAME
// agent really do collide (both auto-resume that agent's newest conversation), but Claude and Codex share
// no conversation store, so the count has to be per-agent.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

// countAgentPeers shells out to `docker ps`. Stub docker with a script on PATH that prints canned rows in
// the exact `{{.Label "mrc.agent"}}\t{{.Label "mrc.worker"}}` format the real call requests.
function withFakeDocker(rows, fn) {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'mrc-fakedocker-'))
  const data = join(dir, 'rows.txt')
  // Rows go in a DATA FILE the stub cats, rather than being interpolated into the script — embedding them
  // in a printf would mean escaping tabs/newlines through two layers and silently mis-rendering the fixture.
  fs.writeFileSync(data, rows.map(r => r.join('\t')).join('\n') + (rows.length ? '\n' : ''))
  fs.writeFileSync(join(dir, 'docker'), `#!/bin/sh\ncat ${JSON.stringify(data)}\n`)
  fs.chmodSync(join(dir, 'docker'), 0o755)
  const prevPath = process.env.PATH
  process.env.PATH = `${dir}:${prevPath}`
  try { return fn() } finally { process.env.PATH = prevPath }
}

const load = async () => (await import(`../src/docker.js?t=${Math.random()}`)).countAgentPeers

test('a Claude peer does NOT count for a codex launch (the reported bug)', async () => {
  const countAgentPeers = await load()
  const peers = withFakeDocker([['claude', '']], () => countAgentPeers('/repo', 'codex'))
  assert.equal(peers, 0, 'an open Claude session must not force Codex to start fresh')
})

test('a same-agent peer DOES count (the collision the force exists for)', async () => {
  const countAgentPeers = await load()
  assert.equal(withFakeDocker([['codex', '']], () => countAgentPeers('/repo', 'codex')), 1)
  assert.equal(withFakeDocker([['claude', '']], () => countAgentPeers('/repo', 'claude')), 1)
})

test('an unlabelled container counts as claude (pre-label containers stay visible)', async () => {
  const countAgentPeers = await load()
  // Sessions started before mrc.agent existed carry no label. Treating that as claude keeps the force
  // working for Claude instead of silently going blind until every container restarts.
  assert.equal(withFakeDocker([['', '']], () => countAgentPeers('/repo', 'claude')), 1)
  assert.equal(withFakeDocker([['', '']], () => countAgentPeers('/repo', 'codex')), 0)
})

test('workers are excluded — they are one-shot execs, not sessions', async () => {
  const countAgentPeers = await load()
  assert.equal(withFakeDocker([['codex', '1']], () => countAgentPeers('/repo', 'codex')), 0)
})

test('counts only matching rows in a mixed repo', async () => {
  const countAgentPeers = await load()
  const rows = [['claude', ''], ['codex', ''], ['claude', ''], ['codex', '1']]
  assert.equal(withFakeDocker(rows, () => countAgentPeers('/repo', 'claude')), 2)
  assert.equal(withFakeDocker(rows, () => countAgentPeers('/repo', 'codex')), 1)   // the worker row is dropped
})

test('no containers, and a docker failure, both yield 0', async () => {
  const countAgentPeers = await load()
  assert.equal(withFakeDocker([], () => countAgentPeers('/repo', 'codex')), 0)
  // docker missing entirely → must not throw, and must not force anything on a guess
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'mrc-nodocker-'))
  const prev = process.env.PATH
  process.env.PATH = dir
  try { assert.equal(countAgentPeers('/repo', 'codex'), 0) } finally { process.env.PATH = prev }
})
