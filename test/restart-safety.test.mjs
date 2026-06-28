// #21b + F2 + F3 — the restart-safety hardening package.
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import { join } from 'node:path'
import { daemonVersion } from '../src/daemon-version.js'
import { saveInbox, loadInbox, loadUserPrefs, saveUserPrefs } from '../src/rooms.js'

test('#21b daemonVersion: deterministic; changes on ANY .js edit/add (incl. nested); ignores non-.js', () => {
  const dir = fs.mkdtempSync(`${os.tmpdir()}/mrc-ver-`)
  fs.writeFileSync(join(dir, 'a.js'), 'export const a = 1')
  fs.mkdirSync(join(dir, 'teams'))
  fs.writeFileSync(join(dir, 'teams', 'trust.js'), 'export const t = 1')   // a nested module (like the real ones the old stamp missed)
  fs.writeFileSync(join(dir, 'config.json'), '{}')                          // a non-.js — must NOT affect the stamp

  const v1 = daemonVersion(dir)
  assert.match(v1, /^[0-9a-f]{12}$/, '12-hex stamp')
  assert.equal(daemonVersion(dir), v1, 'deterministic — same tree, same stamp')

  fs.writeFileSync(join(dir, 'teams', 'trust.js'), 'export const t = 2')    // edit a NESTED .js (the bug class)
  const v2 = daemonVersion(dir)
  assert.notEqual(v2, v1, 'a nested-module edit changes the stamp (the old single-file hash would NOT)')

  fs.writeFileSync(join(dir, 'b.js'), 'export const b = 3')                 // add a .js
  const v3 = daemonVersion(dir)
  assert.notEqual(v3, v2, 'adding a .js changes the stamp')

  fs.writeFileSync(join(dir, 'config.json'), '{ "x": 1 }')                  // edit a non-.js
  assert.equal(daemonVersion(dir), v3, 'a non-.js edit does NOT change the stamp')
})

test('#21b: the REAL src tree stamp is a stable 12-hex (and would catch an engine/config edit)', () => {
  // The production no-arg call hashes the whole src/ tree — so config.js, constants.js, room-engine.js,
  // trust.js, telegram*.js are all in scope by construction (every .js under src/). Just sanity-check shape.
  assert.match(daemonVersion(), /^[0-9a-f]{12}$/)
})

test('#42c user-prefs store: default {}, atomic shallow-merge keeps independent fields, corrupt → {}', () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-prefs-`)
  assert.deepEqual(loadUserPrefs(), {}, 'missing file → {} default')
  saveUserPrefs({ turnCap: 300 })
  assert.equal(loadUserPrefs().turnCap, 300)
  // a second writer (notify) must NOT clobber the turn-cap field — shallow merge-on-write
  saveUserPrefs({ notify: { chime: false, questions: true, fyis: true } })
  const p = loadUserPrefs()
  assert.equal(p.turnCap, 300, 'turn-cap survives the notify write')
  assert.deepEqual(p.notify, { chime: false, questions: true, fyis: true })
  // corrupt file → {} fallback (loadJsonFile quarantines), never a throw
  fs.writeFileSync(join(process.env.HOME, '.local', 'share', 'mrc', 'user-prefs.json'), '{bad json')
  assert.deepEqual(loadUserPrefs(), {})
})

test('#F2 inbox durability: atomic round-trip; a corrupt file logs + preserves aside, never a silent []', () => {
  process.env.HOME = fs.mkdtempSync(`${os.tmpdir()}/mrc-f2-`)
  const dir = join(process.env.HOME, '.local', 'share', 'mrc')
  const file = join(dir, 'room-inbox.json')

  const items = [{ id: 1, text: 'keep my question', type: 'question', answered: false }]
  saveInbox(items)
  assert.deepEqual(loadInbox(), items, 'round-trips through the atomic write')
  assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.tmp-')), 'no orphan temp left after a clean write')

  // Simulate a torn/garbled write (what a SIGKILL mid-save used to leave).
  fs.writeFileSync(file, '{ "items": [ { "id": 1, "text": "kee')
  assert.deepEqual(loadInbox(), [], 'corrupt file → fallback, NOT a throw')
  // ...but NOT silently: the bytes are preserved aside and the corruption is logged.
  assert.ok(fs.readdirSync(dir).some((n) => /^room-inbox\.json\.corrupt-\d+$/.test(n)), 'corrupt bytes preserved as .corrupt-<ts>')
  const log = join(dir, 'daemon.log')
  assert.ok(fs.existsSync(log) && /corrupt JSON in .*room-inbox\.json/.test(fs.readFileSync(log, 'utf8')), 'corruption logged to daemon.log')

  // Recovery: a fresh save writes a clean file (the corrupt one was quarantined, not overwritten).
  saveInbox([{ id: 2, text: 'after recovery' }])
  assert.equal(loadInbox()[0]?.id, 2, 'recovers — the next save is clean')
})

test('#F3: the daemon boot registers uncaughtException + unhandledRejection handlers that LOG (no silent death)', () => {
  const src = fs.readFileSync(new URL('../src/proxies/room-daemon.js', import.meta.url), 'utf8')
  assert.match(src, /process\.on\('uncaughtException'/, 'uncaughtException handler present')
  assert.match(src, /process\.on\('unhandledRejection'/, 'unhandledRejection handler present')
  assert.match(src, /\[FATAL\] uncaughtException/, 'logs the uncaught error (to daemonLog) before any exit')
})
