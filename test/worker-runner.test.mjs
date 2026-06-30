// Unit tests for the worker runner core (prompt building, batching, invoke, post-back) with a fake
// invoker — the container exec is the injected seam and isn't exercised here.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createRoomEngine } from '../src/teams/room-engine.js'
import { createWorkerRunner, buildWorkerPrompt, workerLogPath, parseWorkerLog, workerCallOk } from '../src/teams/worker-runner.js'
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
  engine.bindSession('shop', 'roland/claude', 'sess:roland')
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
  engine.bindSession('shop', 'roland/claude', 's1')
  const runner = createWorkerRunner({ engine, invoke: async () => ({ text: 'built the parser at src/parse.js' }) })
  engine.route({ fromHandle: 'roland/claude', roomId: teamRoomId('shop', 'client'), text: '@thierry build the parser' })
  await runner.tick()
  const log = fs.readFileSync(workerLogPath(repo, 'thierry/codex'), 'utf8')
  assert.match(log, /build the parser/)     // the request
  assert.match(log, /built the parser at src\/parse\.js/)   // the result
})

// --- #48: JSONL call-history records ---
function mediaSetup() {
  const repo = fs.mkdtempSync(join(os.tmpdir(), 'mrc-w48-'))
  const engine = createRoomEngine({ send: () => {}, append: () => {}, notify: () => {} })
  const norm = parseRoster({ org: 'shop', repo, teams: [{ name: 'c', members: [
    { role: 'architect', backend: 'claude', name: 'roland', lead: true },
    { role: 'designer', backend: 'gemini', name: 'come' },
  ] }] }, { rng: seededRng(1) })
  engine.defineOrg({ org: norm.org, repo: norm.repo, members: norm.members, rooms: norm.rooms })
  engine.bindSession('shop', 'roland/claude', 's1')
  return { repo, engine, roomId: teamRoomId('shop', 'c') }
}

test('#48 logWorker emits a JSONL call-history record with the media asset (at/ok/askers/kind/asset)', async () => {
  const { repo, engine, roomId } = mediaSetup()
  const runner = createWorkerRunner({ engine, invoke: async () => ({ text: 'Generated image: `assets/x.png` (12 KB)', asset: { path: 'assets/x.png', ext: 'png', bytes: 12000, kind: 'image', prompt: 'a cat' } }) })
  engine.route({ fromHandle: 'roland/claude', roomId, text: '@come make a cat sprite' })
  await runner.tick()
  const { records } = parseWorkerLog(fs.readFileSync(workerLogPath(repo, 'come/gemini'), 'utf8'))
  assert.equal(records.length, 1)
  const r = records[0]
  assert.equal(r.ok, true)
  assert.equal(r.kind, 'image')
  assert.deepEqual(r.asset, { path: 'assets/x.png', ext: 'png', bytes: 12000, prompt: 'a cat' })
  assert.equal(r.askers[0].text, '@come make a cat sprite')   // the raw message that triggered the call
  assert.equal(r.askers[0].from, '@roland')   // DISPLAY name (@First), not the raw first/backend handle
  assert.equal(r.askers[0].directive, false)
  assert.ok(r.at && r.result)
})

test('#48 media signals failure EXPLICITLY (ok:false) → recorded as a failed call, no asset', async () => {
  const { repo, engine, roomId } = mediaSetup()
  // media.js returns { text, ok:false } on every guard/error path (throttle here) — authoritative, not regex.
  const runner = createWorkerRunner({ engine, invoke: async () => ({ text: '[@Côme: throttled — too many image generations in this room]', ok: false }) })
  engine.route({ fromHandle: 'roland/claude', roomId, text: '@come make another' })
  await runner.tick()
  const { records } = parseWorkerLog(fs.readFileSync(workerLogPath(repo, 'come/gemini'), 'utf8'))
  assert.equal(records[0].ok, false, 'explicit ok:false is recorded as a failed call')
  assert.equal(records[0].asset, null)
})

test('#48 a non-keyword media error (not-a-media-role / nothing-to-make) is STILL ok:false via explicit signal', async () => {
  const { repo, engine, roomId } = mediaSetup()
  // text a regex on (couldn't|throttled|read as feedback) would MISS — only the explicit ok:false catches it (Roland #48-1).
  const runner = createWorkerRunner({ engine, invoke: async () => ({ text: '[@Côme: nothing to make — say what you want generated]', ok: false }) })
  engine.route({ fromHandle: 'roland/claude', roomId, text: '@come hi' })
  await runner.tick()
  const { records } = parseWorkerLog(fs.readFileSync(workerLogPath(repo, 'come/gemini'), 'utf8'))
  assert.equal(records[0].ok, false)
})

test('#48 parseWorkerLog tolerates legacy text lines (never throws); splits records vs legacy', () => {
  const raw = [
    '2026-01-01T00:00:00Z  @Côme (designer)', ' asked:', '  roland: make a thing', ' result: done', '',
    JSON.stringify({ at: 't', ok: true, askers: [{ from: '@r', text: 'x', directive: false }], result: 'y', kind: null, asset: null }),
    'not json at all',
  ].join('\n')
  const { records, legacy } = parseWorkerLog(raw)
  assert.equal(records.length, 1)
  assert.equal(records[0].result, 'y')
  assert.match(legacy, /make a thing/)
  assert.match(legacy, /not json at all/)
})

test('#48 workerCallOk: explicit ok is authoritative; codex = !threw (no server text heuristic)', () => {
  assert.equal(workerCallOk(false, undefined), true)   // codex ran + returned → ✓ (tone-agnostic)
  assert.equal(workerCallOk(true, undefined), false)   // threw → ✕
  assert.equal(workerCallOk(false, false), false)      // media explicit failure (incl. ones no regex would catch)
  assert.equal(workerCallOk(false, true), true)        // media explicit success
  assert.equal(workerCallOk(true, false), false)       // a throw always wins (defensive)
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
