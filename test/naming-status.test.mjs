// generateName status contract (#52): the no-network returns the watcher's retry loop branches on —
// 'exists'/'no-key' = TERMINAL (stop), 'too-short' = RETRYABLE (transcript below the floor, try again
// as it grows). The 'named'/'error' paths need the live API and are covered by the live run. Also
// asserts the #48×#52 interaction: a transcript dominated by injected <channel> content is 'too-short'
// (a pure-consultation session STAYS UNNAMED — never named after the peer).
//
// Network-safe by construction: env keys are deleted up front (so a missed short-circuit returns
// 'no-key', never a real call), and the only tests that set a (dummy) key feed a sub-floor transcript
// so generateName returns BEFORE callHaiku.
//   node test/naming-status.test.mjs
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { generateName } = await import('../src/sessions/api.js')
const { saveMeta } = await import('../src/sessions/manager.js')

const KEY = 'MRC_SESSION_NAMING_ANTHROPIC_API_KEY'
const saved = { key: process.env[KEY], legacy: process.env.ANTHROPIC_API_KEY }
const clearKeys = () => { delete process.env[KEY]; delete process.env.ANTHROPIC_API_KEY }
const dummyKey = () => { process.env[KEY] = 'dummy-no-network-floor-returns-first'; delete process.env.ANTHROPIC_API_KEY }
clearKeys()   // up front: no real network call can happen even if a short-circuit regresses

let pass = 0, fail = 0
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (e) { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${e.message}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'mrc-naming-'))
const writeJsonl = (uuid, turns) => writeFileSync(join(dir, `${uuid}.jsonl`), turns.map((o) => JSON.stringify(o)).join('\n') + '\n')
const human = (text) => ({ type: 'user', message: { content: text } })
const channel = (text) => ({ type: 'user', isMeta: true, message: { content: `<channel source="plugin:room:room">\n${text}` } })

console.log('\ngenerateName — status contract (#52)')

await t("'exists' when already named (terminal, no network)", async () => {
  writeJsonl('u-named', [human('a'.repeat(400))])
  saveMeta(dir, 'u-named', { name: 'already-here' })
  assert.equal(await generateName(dir, 'u-named'), 'exists')
})

await t("'no-key' when no naming key is set (terminal, no network)", async () => {
  writeJsonl('u-nokey', [human('refactor the auth middleware '.repeat(20))])
  assert.equal(await generateName(dir, 'u-nokey'), 'no-key')
})

await t("'too-short' when the transcript is below the naming floor (retryable, no network)", async () => {
  dummyKey()
  writeJsonl('u-short', [human('hi')])
  assert.equal(await generateName(dir, 'u-short'), 'too-short')
  clearKeys()
})

await t("#48x#52: a transcript dominated by injected <channel> content is 'too-short' (stays unnamed, not peer-named)", async () => {
  dummyKey()
  writeJsonl('u-consult', [channel('Peer (asker) says: "' + 'analyze the egress proxy. '.repeat(80) + '"'), human('ok')])
  assert.equal(await generateName(dir, 'u-consult'), 'too-short')
  clearKeys()
})

// restore env + cleanup
if (saved.key === undefined) delete process.env[KEY]; else process.env[KEY] = saved.key
if (saved.legacy === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.legacy
try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\ngenerateName status: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
