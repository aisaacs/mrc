// Unit tests for the worker runner core (prompt building, batching, invoke, post-back) with a fake
// invoker — the container exec is the injected seam and isn't exercised here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createRoomEngine } from '../src/teams/room-engine.js'
import { createWorkerRunner, buildWorkerPrompt, workerLogPath } from '../src/teams/worker-runner.js'
import { parseRoster, teamRoomId } from '../src/teams/roster.js'

function seededRng(seed = 1) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 } }

function setup() {
  const sent = []
  const engine = createRoomEngine({ send: (sessionId, frame) => sent.push({ sessionId, frame }), append: () => {}, notify: () => {} })
  const norm = parseRoster({
    org: 'shop', repo: '/tmp/shop',
    teams: [{ name: 'client', territory: 'client', members: [
      { role: 'architect', backend: 'claude', name: 'roland', lead: true },
      { role: 'engineer', backend: 'codex', name: 'thierry', territory: 'client/api' },
    ] }],
  }, { rng: seededRng(1) })
  engine.defineOrg({ org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms })
  engine.bindSession('roland/claude', 'sess:roland')
  return { engine, sent, roomId: teamRoomId('shop', 'client') }
}

test('buildWorkerPrompt frames peer (untrusted) and directive (authoritative) lines', () => {
  const member = { first: 'Thierry', role: 'engineer', roleLabel: 'Engineer', team: 'client', territory: 'client/api', mount: 'rw' }
  const p = buildWorkerPrompt(member, [
    { fromHandle: 'roland/claude', text: 'build the parser' },
    { directive: true, text: '[Human directive]: use streaming' },
  ], (h) => '@' + h.split('/')[0])
  assert.match(p, /You are @Thierry/)
  assert.match(p, /edit files under `client\/api`/)
  assert.match(p, /Peer \(@roland\) says: "build the parser"/)
  assert.match(p, /\[Human directive\]: use streaming/)
})

test('runner: invokes the worker for a mention and posts the reply back to the sender', async () => {
  const { engine, sent, roomId } = setup()
  const seen = []
  const runner = createWorkerRunner({ engine, invoke: async (member, ctx) => { seen.push({ member: member.handle, prompt: ctx.prompt }); return { text: 'parser done: see client/api/parse.js' } } })

  // Architect @mentions the codex engineer -> queued (not delivered live).
  engine.route({ fromHandle: 'roland/claude', roomId, text: '@thierry build the parser' })
  assert.equal(engine.status().workerQueue, 1)
  assert.equal(sent.filter((s) => s.frame.type === 'deliver').length, 0)

  await runner.tick()

  assert.equal(seen.length, 1, 'worker invoked once')
  assert.equal(seen[0].member, 'thierry/codex')
  assert.match(seen[0].prompt, /build the parser/)
  // Reply posted back to roland (the sender), delivered to his live session.
  const toRoland = sent.filter((s) => s.sessionId === 'sess:roland' && s.frame.type === 'deliver')
  assert.equal(toRoland.length, 1)
  assert.match(toRoland[0].frame.text, /parser done/)
  assert.equal(engine.status().workerQueue, 0, 'queue drained')
})

test('runner: batches a burst of mentions to one worker into a single invocation', async () => {
  const { engine, roomId } = setup()
  let calls = 0
  const runner = createWorkerRunner({ engine, invoke: async () => { calls++; return { text: 'ok' } } })
  engine.route({ fromHandle: 'roland/claude', roomId, text: '@thierry step one' })
  engine.route({ fromHandle: 'roland/claude', roomId, text: '@thierry step two' })
  await runner.tick()
  assert.equal(calls, 1, 'two mentions in one drain -> one invocation')
})

test('runner writes a per-member log file (request + result)', async () => {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-wlog-'))
  const engine = createRoomEngine({ send: () => {}, append: () => {}, notify: () => {} })
  const norm = parseRoster({ org: 'shop', repo, teams: [{ name: 'client', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'engineer', backend: 'codex', name: 'thierry' },
  ] }] }, { rng: seededRng(1) })
  engine.defineOrg({ org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms })
  engine.bindSession('roland/claude', 's1')
  const runner = createWorkerRunner({ engine, invoke: async () => ({ text: 'built the parser at src/parse.js' }) })
  engine.route({ fromHandle: 'roland/claude', roomId: teamRoomId('shop', 'client'), text: '@thierry build the parser' })
  await runner.tick()
  const log = fs.readFileSync(workerLogPath(repo, 'thierry/codex'), 'utf8')
  assert.match(log, /build the parser/)     // the request
  assert.match(log, /built the parser at src\/parse\.js/)   // the result
})

test('runner: a failing invoke posts a graceful error, never silently drops', async () => {
  const { engine, sent, roomId } = setup()
  const runner = createWorkerRunner({ engine, invoke: async () => { throw new Error('codex not installed') } })
  engine.route({ fromHandle: 'roland/claude', roomId, text: '@thierry do it' })
  await runner.tick()
  const toRoland = sent.filter((s) => s.sessionId === 'sess:roland' && s.frame.type === 'deliver')
  assert.equal(toRoland.length, 1)
  assert.match(toRoland[0].frame.text, /could not run: codex not installed/)
})
