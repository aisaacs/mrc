// extractTranscript — #48: excludeMeta strips system-injected user turns (room/channel peer
// messages, the --continue resume marker, local-command caveats) so the auto-namer names a
// CONSULTED session from its own input, not the peer's topic. Summaries leave excludeMeta off.
//   node test/transcript.test.mjs
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { extractTranscript } = await import('../src/sessions/transcript.js')

let pass = 0, fail = 0
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  catch (e) { fail++; console.log(`  \x1b[31m✗ ${name}\x1b[0m\n    ${e.message}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'mrc-transcript-'))
const write = (uuid, turns) =>
  writeFileSync(join(dir, `${uuid}.jsonl`), turns.map((o) => JSON.stringify(o)).join('\n') + '\n')

// Helpers for the four turn shapes we care about.
const human = (text) => ({ type: 'user', message: { content: text } })
const channel = (text, isMeta = true) => ({ type: 'user', isMeta, message: { content: `<channel source="plugin:room:room" chat_id="1">\n${text}` } })
const metaMarker = (text) => ({ type: 'user', isMeta: true, message: { content: text } })
const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

console.log('\nextractTranscript — #48 excludeMeta')

// --- A mixed session: own prompts + assistant work + an injected peer consultation + a resume marker.
const PEER = 'Peer (Kratos [abc123]) says: "investigate the rooms daemon stall handling"'
write('mixed', [
  human('help me refactor the auth middleware'),
  channel(PEER),
  metaMarker('Continue from where you left off.'),
  assistant('Looking at the auth middleware now.'),
  human('the channel server needs a retry on disconnect'),   // non-meta, mentions "channel" — must survive
])

t('default (summary path): keeps the injected peer turn + resume marker', () => {
  const tr = extractTranscript(dir, 'mixed')
  assert.ok(tr.includes('Kratos'), 'peer text should be present by default')
  assert.ok(tr.includes('Continue from where you left off'), 'resume marker present by default')
})

t('excludeMeta: drops the peer turn AND the resume marker', () => {
  const tr = extractTranscript(dir, 'mixed', 0, { excludeMeta: true })
  assert.ok(!tr.includes('Kratos'), 'peer text must be stripped')
  assert.ok(!tr.includes('rooms daemon stall'), 'peer topic must be stripped')
  assert.ok(!tr.includes('Continue from where you left off'), 'resume marker must be stripped')
})

t('excludeMeta: keeps the human\'s OWN prompts and the assistant\'s work', () => {
  const tr = extractTranscript(dir, 'mixed', 0, { excludeMeta: true })
  assert.ok(tr.includes('refactor the auth middleware'), 'own prompt kept')
  assert.ok(tr.includes('the channel server needs a retry'), 'a non-meta prompt that says "channel" is kept')
  assert.ok(tr.includes('Looking at the auth middleware'), 'assistant work kept')
})

// --- The #48 pathology: a fresh session whose ONLY content is a peer's (large) prompt.
const BIG_PEER = 'Peer (Kratos [abc123]) says: "' + 'analyze the firewall egress path. '.repeat(60) + '"'
write('consulted', [
  channel(BIG_PEER),
  assistant('ok'),   // a token reply
])

t('excludeMeta: a pure-consultation session reduces to near-nothing (floor then skips naming)', () => {
  const full = extractTranscript(dir, 'consulted', 0)
  const stripped = extractTranscript(dir, 'consulted', 0, { excludeMeta: true })
  assert.ok(full.length > 1000, 'unstripped is dominated by the peer prompt')
  assert.ok(!stripped.includes('firewall egress'), 'peer topic stripped')
  assert.ok(stripped.trim().length < 200, `stripped is below the 200-char naming floor (was ${stripped.trim().length})`)
})

// --- The injected turn must not consume the maxChars budget meant for real content.
write('budget', [
  channel('Peer (X) says: "' + 'noise '.repeat(400) + '"'),   // big injected turn FIRST
  human('design the retry backoff for the egress proxy'),
])

t('excludeMeta: skipped meta turns do NOT eat the maxChars budget', () => {
  const tr = extractTranscript(dir, 'budget', 2000, { excludeMeta: true })
  assert.ok(tr.includes('design the retry backoff'), 'the real prompt after a big skipped meta turn still lands')
  assert.ok(!tr.includes('noise'), 'the skipped meta turn contributes nothing')
})

// --- Belt-and-suspenders: a <channel>-prefixed turn is stripped even if a build forgot isMeta.
write('nometa', [
  channel('Peer (Y) says: "the load balancer config"', false),   // isMeta:false but <channel-prefixed
  human('write the deploy script'),
])

t('excludeMeta: a <channel>-prefixed turn is stripped even without isMeta', () => {
  const tr = extractTranscript(dir, 'nometa', 0, { excludeMeta: true })
  assert.ok(!tr.includes('load balancer'), 'channel-prefixed turn stripped via prefix guard')
  assert.ok(tr.includes('write the deploy script'), 'own prompt kept')
})

try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\nextractTranscript: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
