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
  assistant('Looking at the auth middleware now.'),          // own work AFTER a human prompt → kept
  channel(PEER),                                             // peer ask → poisons what follows
  metaMarker('Continue from where you left off.'),           // resume boilerplate — does NOT clear the peer-context
  human('the channel server needs a retry on disconnect'),   // human retakes the floor (non-meta, says "channel") — must survive
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

// --- OBJ-4: the assistant REPLY to a peer ask is about the peer's topic → dropped; but own work resumed
// after a --continue marker must survive (a resume marker is boilerplate, not a peer ask, so it must not poison).
write('obj4', [
  human('build the export pipeline'),                              // own topic
  channel('Peer (Z) says: "audit the SNI proxy ClientHello path"'),// peer ask → poisons what follows
  assistant('The SNI proxy validates the in-tunnel ClientHello SNI against the allowlist.'),  // reply to peer → DROP
  human('ok, back to the export pipeline — wire the batch writer'),// HUMAN retakes the floor → clears the peer-context
  assistant('Wiring the batch writer for the export pipeline now.'),  // own work after a human prompt → KEEP
])

t('OBJ-4: assistant reply to a peer ask is dropped; own work after the human retakes the floor survives', () => {
  const tr = extractTranscript(dir, 'obj4', 0, { excludeMeta: true })
  assert.ok(!tr.includes('audit the SNI'), 'the peer ask itself is dropped')
  assert.ok(!tr.includes('validates the in-tunnel'), 'the assistant REPLY to the peer ask is dropped (it is about the peer topic)')
  assert.ok(tr.includes('build the export pipeline'), 'the human own prompt is kept')
  assert.ok(tr.includes('back to the export pipeline'), 'the human retaking the floor is kept')
  assert.ok(tr.includes('Wiring the batch writer'), 'own work AFTER the human retakes the floor is KEPT — only a real human prompt clears the peer-context (a resume marker/tool_result does not)')
})

// --- OBJ-4 (sticky): a tool_result is ALSO a type:'user' turn (empty after the text filter). It must NOT reset
// the peer-context, or every tool-using consultation (i.e. every real code review) leaks the peer's topic.
const toolResult = () => ({ type: 'user', isMeta: false, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } })
write('toolconsult', [
  channel('Peer (Q) says: "audit the SNI proxy ClientHello path"'),  // peer ask → metaContext=true
  assistant('Let me read sni-proxy.js.'),                            // reply chunk 1 → dropped
  toolResult(),                                                      // tool_result USER turn — must NOT clear the context
  assistant('The SNI proxy validates the in-tunnel ClientHello against the allowlist.'),  // reply chunk 2 → STILL dropped
])

t('OBJ-4 sticky: a tool_result between the ask and the reply does NOT reset the peer context', () => {
  const tr = extractTranscript(dir, 'toolconsult', 0, { excludeMeta: true })
  assert.ok(!tr.includes('Let me read sni-proxy'), 'reply chunk before the tool_result is dropped')
  assert.ok(!tr.includes('validates the in-tunnel'), 'reply chunk AFTER the tool_result is ALSO dropped (metaContext sticky across tool results)')
  assert.equal(tr.trim().length, 0, 'a pure tool-using consultation strips to nothing → below the floor → UNNAMED (the real case the text-only test missed)')
})

try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\nextractTranscript: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
