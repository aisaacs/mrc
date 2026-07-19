import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const entrypoint = readFileSync(new URL('../entrypoint.sh', import.meta.url), 'utf8')

test('Codex authentication failures stop startup instead of being swallowed', () => {
  assert.doesNotMatch(entrypoint, /codex login --with-api-key[^\n]*\|\| true/)
  assert.doesNotMatch(entrypoint, /codex login --device-auth[^\n]*\|\| true/)
  assert.match(entrypoint, /if ! printenv OPENAI_API_KEY \| codex login --with-api-key/)
  assert.match(entrypoint, /if ! codex login --device-auth/)
  assert.match(entrypoint, /device authentication was cancelled or failed/)
})
