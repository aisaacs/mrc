// #52/#14: makeNamer — the retry + anti-hang core of the name-watcher. Deps are injected (fake generateName /
// statSync / sleep) so the load-bearing behaviors are provable without a real session or timers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeNamer } from '../src/sessions/name-watcher.js'

const noSleep = async () => {}   // instant, so the 24× file-appearance loop + backoffs don't actually wait

test('nameUntilDone: stops on a TERMINAL status (named/exists/no-key) after one call', async () => {
  for (const terminal of ['named', 'exists', 'no-key']) {
    let calls = 0
    const { nameUntilDone } = makeNamer({ generateName: async () => { calls++; return terminal }, statSync: () => {}, jsonlPath: (u) => u, sleep: noSleep })
    const r = await nameUntilDone('u')
    assert.equal(r, terminal, `returns the terminal status ${terminal}`)
    assert.equal(calls, 1, 'a terminal status stops immediately — no retry')
  }
})

test('nameUntilDone: RETRIES a retryable status, then lands when it goes terminal', async () => {
  const seq = ['too-short', 'too-short', 'error', 'named']
  let i = 0
  const { nameUntilDone } = makeNamer({ generateName: async () => seq[i++], statSync: () => {}, jsonlPath: (u) => u, sleep: noSleep })
  const r = await nameUntilDone('u')   // Infinity
  assert.equal(r, 'named', 'eventually lands on the terminal status')
  assert.equal(i, 4, 'retried through too-short/too-short/error, then named')
})

test('nameUntilDone: RESPECTS maxAttempts — a bounded caller that keeps getting too-short STOPS (never spins)', async () => {
  let calls = 0
  const { nameUntilDone } = makeNamer({ generateName: async () => { calls++; return 'too-short' }, statSync: () => {}, jsonlPath: (u) => u, sleep: noSleep })
  const r = await nameUntilDone('u', 3)   // the post-exit bound
  assert.equal(calls, 3, 'called exactly maxAttempts times — bounded, no infinite spin')
  assert.equal(r, 'gave-up', 'signals it exhausted its attempts')
})

test('nameUntilDone: backoff = min(30000, 5000*(attempt+1))', async () => {
  const slept = []
  const seq = ['too-short', 'too-short', 'too-short', 'too-short', 'too-short', 'too-short', 'too-short', 'named']
  let i = 0
  const { nameUntilDone } = makeNamer({ generateName: async () => seq[i++], statSync: () => {}, jsonlPath: (u) => u, sleep: async (ms) => { slept.push(ms) } })
  await nameUntilDone('u')
  assert.deepEqual(slept.slice(0, 7), [5000, 10000, 15000, 20000, 25000, 30000, 30000], 'linear backoff capped at 30s')
})

test('nameWhenReady: names the pinned file once it appears + grows', async () => {
  let named = null
  // file "exists" from the first stat, size 20KB > gate
  const { nameWhenReady } = makeNamer({
    generateName: async (u) => { named = u; return 'named' },
    statSync: () => ({ size: 20480 }),
    jsonlPath: (u) => `${u}.jsonl`,
    sleep: noSleep,
  })
  const engaged = await nameWhenReady('pinned-uuid')
  assert.equal(engaged, true, 'engaged the pinned file')
  assert.equal(named, 'pinned-uuid', 'named the pinned uuid')
})

test('nameWhenReady: a small session that never reaches the size gate is named ANYWAY after the growth timeout (pre-#14 in-session naming preserved)', async () => {
  let named = null, gen = 0
  const { nameWhenReady } = makeNamer({
    generateName: async (u) => { gen++; named = u; return 'named' },
    statSync: () => ({ size: 100 }),   // file exists but NEVER reaches ~10KB
    jsonlPath: (u) => `${u}.jsonl`,
    sleep: noSleep,
  })
  const engaged = await nameWhenReady('small-uuid', { growthTries: 3 })
  assert.equal(engaged, true, 'engaged the file (it appeared)')
  assert.equal(named, 'small-uuid', 'named it after the bounded growth timeout — not deferred to post-exit')
  assert.equal(gen, 1, 'named once via nameUntilDone')
})

test('#14 ANTI-HANG: a pinned .jsonl that NEVER appears TERMINATES within the bound and returns false (fall through, no hang)', async () => {
  let genCalls = 0
  const { nameWhenReady } = makeNamer({
    generateName: async () => { genCalls++; return 'named' },
    statSync: () => { throw new Error('ENOENT') },   // the file NEVER appears (a --session-id regression)
    jsonlPath: (u) => `${u}.jsonl`,
    sleep: noSleep,
  })
  const engaged = await nameWhenReady('phantom-uuid', { fileAppearTries: 24 })
  assert.equal(engaged, false, 'returns FALSE (does not hang / spin forever) so the caller falls through to the heuristic')
  assert.equal(genCalls, 0, 'never tried to name a file that never appeared')
})
