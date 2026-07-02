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

// --- OBJ-C: the belt extends past <channel> to the OTHER injected user turns (--continue marker + local-command /
// slash-command wrappers). If a CC build ever drops isMeta on one of THOSE, it must still not be mistaken for the
// human retaking the floor (which would clear the peer context mid-consult → leak the topic into the name).
write('objc-command', [
  channel('Peer (W) says: "audit the lockfile election path"'),     // peer ask → metaContext=true
  assistant('Reading room-daemon.js for the lock.'),                 // reply → dropped
  { type: 'user', message: { content: '<command-name>compact</command-name>\n<command-message>compact</command-message>' } },  // injected slash-command turn, isMeta ABSENT
  assistant('The lockfile uses process.kill(pid,0) for the election.'),  // STILL a peer reply → must stay dropped
])

t('OBJ-C: an injected <command-*> turn without isMeta stays sticky (belt covers slash-command wrappers)', () => {
  const tr = extractTranscript(dir, 'objc-command', 0, { excludeMeta: true })
  assert.ok(!tr.includes('Reading room-daemon'), 'reply before the injected command turn dropped')
  assert.ok(!tr.includes('process.kill'), 'reply AFTER an isMeta-less <command-*> turn is STILL dropped — structural belt kept metaContext sticky')
  assert.ok(!tr.includes('command-name'), 'the injected command turn itself is dropped')
})

write('objc-continue', [
  channel('Peer (V) says: "check the SNI ClientHello path"'),       // peer ask → metaContext=true
  assistant('reply-to-peer-one'),                                   // dropped
  { type: 'user', message: { content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion.' } },  // --continue marker, isMeta ABSENT
  assistant('reply-to-peer-two'),                                   // STILL dropped (marker did not clear the context)
  human('now write the migration script'),                          // REAL human → clears the peer context
  assistant('Writing the migration script now.'),                   // own work → KEPT
])

t('OBJ-C: the --continue marker without isMeta stays sticky; a real human prompt after it still clears', () => {
  const tr = extractTranscript(dir, 'objc-continue', 0, { excludeMeta: true })
  assert.ok(!tr.includes('reply-to-peer-two'), 'reply after the isMeta-less --continue marker is still dropped')
  assert.ok(!tr.includes('being continued from a previous'), 'the --continue marker itself is dropped')
  assert.ok(tr.includes('Writing the migration script'), 'own work after a REAL human prompt is kept — the marker did not permanently poison the session')
})

// --- OBJ-C false-positive (Pierre): the belt overrides isMeta, so an OPEN `<command-` prefix would eat a human's
// own prose that happens to start that way. The well-formed-tag anchor (`<[local-]command-word>`) must let real
// human prose through while still catching the actual injected tags.
write('objc-human-prose', [
  human('<command-line interface> design: should we default to --json or a TTY?'),   // human prose opening with "<command-" but NOT a well-formed CC tag
  assistant('Defaulting to a TTY is friendlier; --json is opt-in.'),
])

t('OBJ-C: a human prompt opening "<command-line ...>" is NOT dropped (anchor requires a well-formed tag close)', () => {
  const tr = extractTranscript(dir, 'objc-human-prose', 0, { excludeMeta: true })
  assert.ok(tr.includes('command-line interface'), 'human prose starting "<command-" survives — it is not a well-formed <command-word> tag')
  assert.ok(tr.includes('Defaulting to a TTY'), 'the assistant reply to a genuine human prompt is kept (no false peer-context)')
})

try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\nextractTranscript: ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
