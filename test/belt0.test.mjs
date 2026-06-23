// Belt 0 (sanitizeRepoConfig) — asserts the GUARANTEE, not a list of known-bad items: anything outside
// the safe allow-set is stripped, INCLUDING tokens never seen by the source or by this test. That's the
// property the namespace-reserve + deny-by-default give that a denylist cannot.
//   node test/belt0.test.mjs
import assert from 'node:assert'
import { sanitizeRepoConfig, tokenizeArgs, parseArgs } from '../src/config.js'

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (e) { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${e.message}`) }
}
// run with a no-op warn; assert on what's KEPT
const keptFlags = (...flags) => sanitizeRepoConfig(flags, [], () => {}).flags
const keptEnvs = (...envs) => sanitizeRepoConfig([], envs, () => {}).envs

console.log('\nBelt 0 — repo .mrcrc allowlist (deny-by-default)')

// --- ENV namespace reserve (the guarantee, not the known names) ---
t('strips a NEVER-SEEN MRC_ env — namespace guarantee, not an enumerated name', () => {
  assert.deepEqual(keptEnvs('MRC_FOO=1'), [])
  assert.deepEqual(keptEnvs('MRC_TOTALLY_NEW_KNOB=x'), [])
})
t('strips the known containment envs + ALLOW_WEB', () => {
  assert.deepEqual(keptEnvs('MRC_ADVERSARY=', 'MRC_ADVERSARY_FW=1', 'MRC_SUMMONED_BY=x', 'ALLOW_WEB=1'), [])
})
t('keeps a non-reserved app env (legit per-repo passthrough)', () => {
  assert.deepEqual(keptEnvs('MY_APP_VAR=hello'), ['MY_APP_VAR=hello'])
})

// --- FLAG allowlist (the guarantee) ---
t('strips a NEVER-SEEN flag — deny-by-default catches what no denylist would', () => {
  assert.deepEqual(keptFlags('--futureflag'), [])
  assert.deepEqual(keptFlags('--some-knob-added-next-quarter'), [])
})
t('strips egress / containment / trust / resource / mode / hijack flags', () => {
  for (const f of ['-w', '--web', '--room evil', '--rooms', '--agent codex', '--summoned-by x',
                   '--open-adversary-unsafe', '--colima-memory 999', '--colima-cpu 8', '--rebuild',
                   '-r', '--daemon', '--json', '-j', '--', '-h', '--help'])
    assert.deepEqual(keptFlags(f), [], `expected "${f}" stripped`)
})
t('two-line --room then evil: the flag AND the orphaned value token are both stripped', () => {
  assert.deepEqual(keptFlags('--room', 'evil'), [])
})
t('keeps the safe local-UX flags (+ short aliases)', () => {
  const safe = ['--no-sound', '--no-notify', '--no-summary', '--no-rooms', '--verbose', '-v', '--new', '-n']
  assert.deepEqual(keptFlags(...safe), safe)
})
t('two-line --new then myname: keeps --new, strips the name token (safe-direction)', () => {
  assert.deepEqual(keptFlags('--new', 'myname'), ['--new'])
})

// --- #34: multi-token flag lines tokenize, and the tokenization can't smuggle a 2nd flag past belt-0 ---
t('#34 tokenizeArgs splits a multi-token flag line (quote-aware)', () => {
  assert.deepEqual(tokenizeArgs('--colima-memory 32'), ['--colima-memory', '32'])
  assert.deepEqual(tokenizeArgs('--web'), ['--web'])
  assert.deepEqual(tokenizeArgs('--new "my session"'), ['--new', 'my session'])
  assert.deepEqual(tokenizeArgs(''), [])
})
t('#34 a multi-token flag now actually parses (was silently dropped as one un-matched arg)', () => {
  assert.equal(parseArgs(tokenizeArgs('--colima-memory 32')).config.colimaMemory, '32')
  assert.equal(parseArgs(['--colima-memory 32']).config.colimaMemory, '')   // the OLD (un-tokenized) behavior = dropped
})
t('#34 belt-0 still blocks a repo line smuggling a 2nd flag past an allowed leading one', () => {
  assert.deepEqual(keptFlags(...tokenizeArgs('--no-sound --web')), ['--no-sound'])     // --web dropped, NOT smuggled
  assert.deepEqual(keptFlags(...tokenizeArgs('--new evil-name --rooms')), ['--new'])   // value + 2nd flag both dropped
})

// --- #26/#48: `--new` must NOT eat the repo PATH as the session name (that disabled the auto-namer) ---
t('#26 --new does not consume an existing path as the name (it is the repo)', () => {
  const a = parseArgs(['--new', '/tmp'])            // /tmp exists → repo, NOT a name
  assert.equal(a.config.newSession, true)
  assert.equal(a.config.newSessionName, '', 'an existing path must not be eaten as the session name')
  assert.deepEqual(a.remaining, ['/tmp'])
  const b = parseArgs(['--new', '.'])
  assert.equal(b.config.newSessionName, '')
  assert.deepEqual(b.remaining, ['.'])
})
t('#26 --new still consumes a real (non-path) name, and bare --new takes none', () => {
  assert.equal(parseArgs(['--new', 'my-cool-session-xyz']).config.newSessionName, 'my-cool-session-xyz')
  assert.equal(parseArgs(['.', '--new']).config.newSessionName, '')   // no token after --new → watcher gate stays on
})

// --- the filter touches ONLY the repo arrays it's given (caller keeps global/CLI away from it) ---
t('is a pure function of its inputs (no global/CLI surface inside it)', () => {
  const out = sanitizeRepoConfig(['--web'], ['ALLOW_WEB=1'], () => {})
  assert.deepEqual(out, { flags: [], envs: [] })
})

console.log(`\nBelt 0: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
