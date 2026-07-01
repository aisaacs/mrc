// Belt 0 (sanitizeRepoConfig) — the GUARANTEE, not a list of known-bad items: anything outside the safe
// allow-set is stripped from a repo .mrcrc, INCLUDING tokens never seen here. Deny-by-default (flags) +
// namespace-reserve (MRC_* / ALLOW_WEB envs) give what a denylist cannot. A repo .mrcrc is sandbox-writable,
// so this is what stops a contained session self-escalating its NEXT launch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeRepoConfig } from '../src/config.js'

const keptFlags = (...flags) => sanitizeRepoConfig(flags, [], () => {}).flags
const keptEnvs = (...envs) => sanitizeRepoConfig([], envs, () => {}).envs

test('env namespace reserve — strips any MRC_* (the guarantee, not enumerated names)', () => {
  assert.deepEqual(keptEnvs('MRC_FOO=1'), [])
  assert.deepEqual(keptEnvs('MRC_TOTALLY_NEW_KNOB=x'), [])
  assert.deepEqual(keptEnvs('MRC_ADVERSARY=', 'MRC_ADVERSARY_FW=1', 'MRC_SUMMONED_BY=x', 'ALLOW_WEB=1'), [])
})

test('env — keeps a non-reserved app env (legit per-repo passthrough)', () => {
  assert.deepEqual(keptEnvs('MY_APP_VAR=hello'), ['MY_APP_VAR=hello'])
})

test('flags — deny-by-default strips a NEVER-SEEN flag', () => {
  assert.deepEqual(keptFlags('--futureflag'), [])
  assert.deepEqual(keptFlags('--some-knob-added-next-quarter'), [])
})

test('flags — strips egress / containment / trust / resource / mode / hijack flags', () => {
  for (const f of ['-w', '--web', '--rooms', '--agent', '--summoned-by', '--open-adversary-unsafe',
                   '--colima-memory', '--colima-cpu', '--rebuild', '-r', '--daemon', '--json', '-j', '--', '-h', '--help'])
    assert.deepEqual(keptFlags(f), [], `expected "${f}" stripped`)
})

test('flags — keeps the safe local-UX flags (+ short aliases)', () => {
  const safe = ['--no-sound', '--no-notify', '--no-summary', '--no-rooms', '--verbose', '-v', '--new', '-n']
  assert.deepEqual(keptFlags(...safe), safe)
})

test('an orphaned VALUE token (e.g. the name after a repo --new) is dropped, not kept', () => {
  // teams readMrcrc pushes each .mrcrc LINE as a token; belt-0 keeps --new but drops a bare value token.
  assert.deepEqual(keptFlags('--new', 'myname'), ['--new'])
  assert.deepEqual(keptFlags('--room', 'evil'), [])   // --room disallowed; its value also drops
})

test('a combined line is dropped wholesale (teams whole-line model) — --web never passes', () => {
  // teams does NOT tokenize .mrcrc lines, so "--no-sound --web" arrives as ONE token → unmatched → dropped.
  // Over-aggressive (loses --no-sound too) but SAFE: --web can never ride through.
  assert.deepEqual(keptFlags('--no-sound --web'), [])
})

test('pure function of its inputs — no global/CLI surface inside it', () => {
  assert.deepEqual(sanitizeRepoConfig(['--web'], ['ALLOW_WEB=1'], () => {}), { flags: [], envs: [] })
})

test('warn fires once per dropped entry (caller owns the notice)', () => {
  const warned = []
  sanitizeRepoConfig(['--web', '--no-sound'], ['MRC_FOO=1', 'OK=1'], (m) => warned.push(m))
  assert.equal(warned.length, 2, 'one warn for --web, one for MRC_FOO (not for the kept --no-sound/OK)')
})
