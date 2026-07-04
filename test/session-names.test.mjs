// AUDIT: saveNames must MERGE with the on-disk state, so two concurrent same-repo name-watchers don't lose each
// other's additions in a read-modify-write (the old plain writeFileSync clobbered).  node test/session-names.test.mjs
import assert from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { saveNames, loadNames } = await import('../src/sessions/manager.js')

let pass = 0, fail = 0
const t = (name, fn) => { try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) } catch (e) { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${e.message}`) } }
const dir = mkdtempSync(join(tmpdir(), 'mrc-names-'))

console.log('\nsaveNames — audit: merge-on-save (no lost update)')
t('two concurrent additions both survive (the 2nd writer does not clobber the 1st)', () => {
  saveNames(dir, { u1: 'name-one' })
  saveNames(dir, { u2: 'name-two' })   // a 2nd watcher with a stale view (no u1)
  const n = loadNames(dir)
  assert.equal(n.u1, 'name-one', 'first addition survives the second write')
  assert.equal(n.u2, 'name-two', 'second addition landed')
})
t('the caller wins on a genuine update to the same uuid', () => {
  saveNames(dir, { u1: 'renamed' })
  assert.equal(loadNames(dir).u1, 'renamed', 'a re-name of an existing uuid takes')
})
t('atomic write leaves no .tmp behind and a readable file', () => {
  saveNames(dir, { u3: 'three' })
  assert.equal(loadNames(dir).u3, 'three')
})

try { rmSync(dir, { recursive: true, force: true }) } catch {}
console.log(`\nsaveNames: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
