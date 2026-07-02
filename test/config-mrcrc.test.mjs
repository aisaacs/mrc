// #34: a multi-token .mrcrc flag line must tokenize (quote-aware) so `--colima-memory 32` parses.  node test/config-mrcrc.test.mjs
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { readMrcrc, tokenizeArgs } = await import('../src/config.js')
let pass = 0, fail = 0
const t = (n, fn) => { try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}`) } catch (e) { fail++; console.log(`  \x1b[31m✗ ${n}\x1b[0m\n    ${e.message}`) } }
const dir = mkdtempSync(join(tmpdir(), 'mrc-mrcrc-'))
console.log('\nreadMrcrc — #34 multi-token flag lines')
t('tokenizeArgs splits quote-aware', () => {
  assert.deepEqual(tokenizeArgs('--colima-memory 32'), ['--colima-memory', '32'])
  assert.deepEqual(tokenizeArgs('--new "my session"'), ['--new', 'my session'])
})
t('a value-flag on one .mrcrc line parses as flag + value (not one dead arg)', () => {
  const f = join(dir, '.mrcrc'); writeFileSync(f, '--colima-memory 32\n--no-sound\n')
  const { flags } = readMrcrc(f)
  assert.deepEqual(flags, ['--colima-memory', '32', '--no-sound'], 'multi-token line tokenized; single flag preserved')
})
t('KEY=VALUE env lines are kept WHOLE (value may contain spaces)', () => {
  const f = join(dir, '.mrcrc2'); writeFileSync(f, 'FOO=a b c\n--verbose\n')
  const { flags, envs } = readMrcrc(f)
  assert.deepEqual(envs, ['FOO=a b c'], 'env value not tokenized')
  assert.deepEqual(flags, ['--verbose'])
})
try { rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(`\nreadMrcrc: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
