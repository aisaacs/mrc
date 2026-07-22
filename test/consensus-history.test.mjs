// t27 quick-win: writeConsensus is a full-overwrite living summary, so a terse update_notes can WIPE a detailed
// prior body (the empty-guard stops an EMPTY erase, not a SHRINK). The displaced body must never be lost: it's
// retained, attributed, in a bounded history sidecar so a destructive shrink is recoverable + diagnosable.
// HOME is redirected so roomsRoot() (os.homedir()-based) lands in an isolated temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

process.env.HOME = fs.mkdtempSync(join(os.tmpdir(), 'mrc-consensus-'))
const { ensureRoom, writeConsensus, readConsensusHistory, roomDir } = await import('../src/rooms.js')

test('a shrink retains the displaced body in the history sidecar, attributed; live doc holds the new body', () => {
  ensureRoom('room-shrink', 'repoA', 'repoB')
  const detailed = 'A long, detailed shared summary with many hard-won conclusions across several lines.'
  writeConsensus('room-shrink', detailed, { by: 'Alice', sessionId: 'sid-alice', at: 1000 })
  writeConsensus('room-shrink', 'ok', { by: 'Bob', sessionId: 'sid-bob', at: 2000 })   // the destructive shrink

  const live = fs.readFileSync(join(roomDir('room-shrink'), 'consensus.md'), 'utf8')
  assert.ok(live.includes('ok'), 'live doc has the new (terse) body')
  assert.ok(!live.includes('hard-won'), 'live doc no longer shows the old body')

  const hist = readConsensusHistory('room-shrink')
  assert.equal(hist.length, 1)
  assert.ok(hist[0].prevBody.includes('hard-won conclusions'), 'the displaced detailed body is preserved')
  assert.equal(hist[0].by, 'Bob', 'attributed to WHOEVER overwrote it (the shrink actor)')
  assert.equal(hist[0].sessionId, 'sid-bob')
  assert.equal(hist[0].at, 2000)
})

test('an identical rewrite and an initial write add NO history noise', () => {
  ensureRoom('room-idem', 'repoA', 'repoB')
  writeConsensus('room-idem', 'same body', { by: 'A', at: 1 })   // first real body (displaces only the template)
  const afterFirst = readConsensusHistory('room-idem').length
  writeConsensus('room-idem', 'same body', { by: 'A', at: 2 })   // identical → nothing lost → no history entry
  assert.equal(readConsensusHistory('room-idem').length, afterFirst, 'identical rewrite adds no history')
})

test('history is bounded (~10) — a burst evicts oldest, keeps newest (noted-in-ticket eviction)', () => {
  ensureRoom('room-cap', 'repoA', 'repoB')
  for (let i = 0; i < 15; i++) writeConsensus('room-cap', `body v${i}`, { by: 'A', at: i })
  const hist = readConsensusHistory('room-cap')
  assert.ok(hist.length <= 10, `bounded, got ${hist.length}`)
  // the most recent displaced body (v13, displaced by v14) is retained; the oldest are evicted
  assert.ok(hist.some((h) => h.prevBody.includes('v13')), 'newest displaced body kept')
  assert.ok(!hist.some((h) => h.prevBody.includes('v0')), 'oldest displaced body evicted')
})
