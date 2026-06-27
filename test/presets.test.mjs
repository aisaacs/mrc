// Presets: each ready-made roster must parse + validate cleanly (and the game preset's media makers
// must not trip the write-overlap warning even though the engineer owns the whole repo).
import test from 'node:test'
import assert from 'node:assert/strict'
import { PRESETS, listPresets, buildPreset } from '../src/teams/presets.js'
import { parseRoster, validateRoster } from '../src/teams/roster.js'

test('listPresets exposes the four kinds', () => {
  const names = listPresets().map((p) => p.name)
  for (const n of ['game', 'web', 'mobile', 'backend']) assert.ok(names.includes(n), `${n} present`)
})

test('every preset parses and validates with no errors', () => {
  for (const name of Object.keys(PRESETS)) {
    const norm = parseRoster(buildPreset(name, { org: 'demo' }), { repo: '/tmp/demo' })
    const v = validateRoster(norm)
    assert.ok(v.ok, `${name} valid`)
    assert.equal(v.errors.length, 0, `${name} no errors`)
    assert.equal(new Set(norm.members.map((m) => m.handle)).size, norm.members.length, `${name} unique handles`)
  }
})

test('game preset has the three media makers and no overlap warning', () => {
  const norm = parseRoster(buildPreset('game', { org: 'demo' }), { repo: '/tmp/demo' })
  const roles = norm.members.map((m) => m.role)
  for (const r of ['designer', 'sound-designer', 'composer']) assert.ok(roles.includes(r))
  const v = validateRoster(norm)
  assert.ok(!v.warnings.some((w) => /write territory/.test(w)), 'media makers exempt from overlap warning')
  // media makers are workers; engineer/architect/critic are live
  assert.equal(norm.members.find((m) => m.role === 'designer').tier, 'worker')
  assert.equal(norm.members.find((m) => m.role === 'engineer').tier, 'live')
})

test('buildPreset rejects an unknown preset', () => {
  assert.throws(() => buildPreset('nope', {}), /unknown preset/)
})
