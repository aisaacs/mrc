// #52: generateName returns a STATUS (not void) so the watcher can retry the retryable cases. This covers the three
// sites reachable WITHOUT the network (exists / no-key / too-short); 'named'/'error' sit behind the Haiku call and are
// exercised via the injected-generateName path in name-watcher.test.mjs (nameUntilDone treats them correctly).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

const { generateName } = await import('../src/sessions/api.js')
const { saveNames } = await import('../src/sessions/manager.js')

const freshMrc = () => fs.mkdtempSync(join(os.tmpdir(), 'mrc-genname-'))
const writeJsonl = (dir, uuid, content) =>
  fs.writeFileSync(join(dir, `${uuid}.jsonl`), JSON.stringify({ type: 'user', message: { content } }) + '\n')

test("generateName → 'exists' when already named", async () => {
  const dir = freshMrc()
  saveNames(dir, { u: 'already-named' })
  assert.equal(await generateName(dir, 'u'), 'exists')
})

test("generateName → 'no-key' when no naming API key is set", async () => {
  const dir = freshMrc()
  writeJsonl(dir, 'u', 'x'.repeat(500))   // long enough that too-short isn't the reason
  const saved = { k: process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY, a: process.env.ANTHROPIC_API_KEY }
  delete process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  try { assert.equal(await generateName(dir, 'u'), 'no-key') }
  finally {
    if (saved.k) process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY = saved.k
    if (saved.a) process.env.ANTHROPIC_API_KEY = saved.a
  }
})

test("generateName → 'too-short' when the own-content transcript is below the naming floor (no Haiku call)", async () => {
  const dir = freshMrc()
  writeJsonl(dir, 'u', 'hi')   // < 200 chars after extract
  const saved = process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY
  process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY = 'sk-ant-fake-for-test'   // present → passes the key gate; too-short returns BEFORE any network call
  try { assert.equal(await generateName(dir, 'u'), 'too-short') }
  finally {
    if (saved) process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY = saved
    else delete process.env.MRC_SESSION_NAMING_ANTHROPIC_API_KEY
  }
})
