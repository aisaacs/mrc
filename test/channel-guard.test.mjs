// Room-channel argument guard — the silent-empty-body fix and its ENFORCEMENT.
//
// WHY THIS FILE EXISTS (the incident it encodes): the model called `reply` with its payload keyed `message` while the
// channel server read only `a.text`, so it shipped `text:''`. The daemon relayed the empty faithfully and the peer saw
// `says [turn N]: ""`. Two of our own gaps turned that into days of silent data loss: the low-level MCP
// `Server`+setRequestHandler NEVER validates a tool's declared inputSchema (so `required:['text']` was decorative), and
// the ack said "Delivered to the peer." regardless — so both agents believed it landed and re-sent into the void.
//
// Pierre's standard, and the reason the classification test below is not optional: "add a predicate" was never the
// ask — "make FORGETTING the predicate a red build" was. A conditional guard that depends on the next author
// remembering to write it is remembered, not enforced. Equally: a green suite that never EXECUTES this code proves
// only that the old code still passes. Reading isn't running.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  consultTools, teamTools, isEscalate, SAFE_OPTIONAL, SUPPORTED_TYPES,
  effectivelyRequired, guardArgs, validateAndCoerce,
} from '../container/mrc-channel-tools.js'

const byName = (name) => [...consultTools, ...teamTools].find((t) => t.name === name)
const allTools = () => {
  const seen = new Map()
  for (const t of [...consultTools, ...teamTools]) seen.set(t.name, t)   // teamTools reuses consult entries via shared()
  return [...seen.values()]
}

// ── GAP B ENFORCEMENT: every string field must be CLASSIFIED, or the build goes red ────────────────────────────────
// A new optional string that flows into a delivery/suppression/overwrite sink is exactly how the escalation bug
// (resolve_escalation.answer) happened. This forces the author to answer "does this reach a sink?" at authoring time.
test('#EMPTY-GUARD enforcement: every string field is required, conditionally-required, or an explicit safe-optional waiver', () => {
  const unclassified = []
  for (const tool of allTools()) {
    const props = tool.inputSchema?.properties || {}
    const required = new Set(tool.inputSchema?.required || [])
    for (const [k, spec] of Object.entries(props)) {
      if (spec?.type !== 'string') continue
      const conditional = typeof tool.requireNonEmpty?.[k] === 'function'
      const waived = (SAFE_OPTIONAL[tool.name] || []).includes(k)
      if (!required.has(k) && !conditional && !waived) unclassified.push(`${tool.name}.${k}`)
    }
  }
  assert.deepEqual(unclassified, [],
    `unclassified string field(s): ${unclassified.join(', ')} — each must be schema-required, carry a requireNonEmpty ` +
    `predicate, or be added to SAFE_OPTIONAL with a written justification. If it reaches a delivery/suppression/` +
    `overwrite sink, an EMPTY value there is the resolve_escalation bug again.`)
})

// The (c) waiver has no runtime teeth — it asserts a field is CLASSIFIED, never that the classification is still TRUE.
// Keep it short and treat additions as security exceptions (Pierre R3).
test('#EMPTY-GUARD: the safe-optional waiver list stays short and intentional', () => {
  const waived = Object.entries(SAFE_OPTIONAL).flatMap(([t, ks]) => ks.map((k) => `${t}.${k}`))
  assert.deepEqual(waived.sort(), ['send_message.room', 'send_photo.caption'])
})

// OPT-IN body marking (Pierre, final): recovery-eligibility is an explicit `body: true`, so the forget-mode is a
// clean refusal rather than a silent wrong-fill. Positive marking is testable in a way an exclusion list isn't —
// this pins the exact set, so adding or removing a recoverable body is a DELIBERATE, reviewed change.
test('#EMPTY-GUARD: recovery-eligible body fields are explicitly marked, and the set is pinned', () => {
  const marked = []
  for (const tool of allTools()) {
    for (const [k, spec] of Object.entries(tool.inputSchema?.properties || {})) {
      if (spec?.body) {
        marked.push(`${tool.name}.${k}`)
        assert.equal(spec.type, 'string', `${tool.name}.${k} is marked body but is not a string`)
      }
    }
  }
  assert.deepEqual(marked.sort(), [
    'ask_peer.question', 'ask_user.text', 'reply.text', 'resolve_escalation.answer',
    'send_message.text', 'submit_handoff.text', 'summon_adversary.brief', 'update_notes.text',
  ], 'body-marked set changed — confirm the new field is genuinely a message BODY (never a path/name/token)')
  // The non-body strings must stay unmarked: a path or a peer name must never be alias-filled.
  for (const [t, k] of [['send_photo', 'path'], ['ask_peer', 'peer'], ['send_message', 'room'], ['send_photo', 'caption']]) {
    assert.ok(!byName(t).inputSchema.properties[k].body, `${t}.${k} must NOT be recovery-eligible`)
  }
})

// Keeps the hand-rolled validator honest: if a tool ever declares a type outside the supported subset, that field
// would silently become unvalidated again — the exact class we just closed. Red build instead.
test('#EMPTY-GUARD: no tool declares a type outside the validator’s supported subset', () => {
  const bad = []
  for (const tool of allTools()) {
    for (const [k, spec] of Object.entries(tool.inputSchema?.properties || {})) {
      if (!SUPPORTED_TYPES.has(spec?.type)) bad.push(`${tool.name}.${k}:${spec?.type}`)
    }
  }
  assert.deepEqual(bad, [], `unsupported declared type(s): ${bad.join(', ')} — extend validateAndCoerce first`)
})

// ── The original bug, end to end ───────────────────────────────────────────────────────────────────────────────────
test('#EMPTY-GUARD: the exact incident — reply keyed `message` recovers instead of shipping an empty body', () => {
  const r = guardArgs(byName('reply'), { message: 'Channel test 3 — short message.' })
  assert.equal(r.ok, true)
  assert.equal(r.args.text, 'Channel test 3 — short message.')
  assert.deepEqual(r.recovered, { from: 'message', to: 'text' })
})

test('#EMPTY-GUARD: a genuinely empty body is REFUSED, never acked as delivered', () => {
  const r = guardArgs(byName('reply'), { text: '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /NOT delivered/)
  assert.match(r.error, /"text"/)
})

// H1: the engine normalizes with .trim() (room-engine.js:27), so a whitespace-only body would pass a naive
// length>0 check here and be trimmed to empty DOWNSTREAM of this chokepoint — silent-empty again.
test('#EMPTY-GUARD: whitespace-only is empty (matches the engine’s own trim)', () => {
  assert.equal(guardArgs(byName('reply'), { text: '   \n\t ' }).ok, false)
})

// R4: constraining only the TARGET still leaves a guess when two candidate bodies arrive. Refuse, don't pick.
test('#EMPTY-GUARD: two candidate bodies → refuse and name them (never guess which the model meant)', () => {
  const r = guardArgs(byName('reply'), { message: 'A', content: 'B' })
  assert.equal(r.ok, false)
  assert.match(r.error, /message/)
  assert.match(r.error, /content/)
})

// H4: ask_peer requires TWO strings, so an aliased blob has no unambiguous slot.
test('#EMPTY-GUARD: multiple unfilled required fields → refuse (no slot-guessing)', () => {
  const r = guardArgs(byName('ask_peer'), { message: 'hello?' })
  assert.equal(r.ok, false)
  assert.match(r.error, /NOT delivered/)
})

test('#EMPTY-GUARD: a well-formed call passes through untouched', () => {
  const r = guardArgs(byName('ask_peer'), { peer: 'shop', question: 'what broke?' })
  assert.equal(r.ok, true)
  assert.equal(r.recovered, undefined)
  assert.equal(r.args.question, 'what broke?')
})

// ── H2: the highest-severity case — a blank resolution consumes the escalation AND disarms the human's backstop ────
// room-engine.js:738 delivers the blank framed as the lead's authoritative answer; :739 sets item.answered=true; and
// checkTriageTimers (:753) only fires for !answered — so the human's timeout fallback is switched off for good.
test('#EMPTY-GUARD H2: resolve_escalation with escalate falsy REQUIRES a non-empty answer', () => {
  const t = byName('resolve_escalation')
  assert.ok(effectivelyRequired(t, { id: 3 }).includes('answer'), 'answer is conditionally required when not escalating')
  const r = guardArgs(t, { id: 3, answer: '' })
  assert.equal(r.ok, false)
  assert.match(r.error, /answer/)
})

test('#EMPTY-GUARD H2: escalate:true exempts `answer` entirely (no false positive)', () => {
  const t = byName('resolve_escalation')
  assert.deepEqual(effectivelyRequired(t, { id: 3, escalate: true }).filter((k) => k === 'answer'), [])
  assert.equal(guardArgs(t, { id: 3, escalate: true }).ok, true)
})

// GAP A: guard and recovery must count over the SAME effectively-required set. resolve_escalation is required:['id']
// with id a NUMBER — zero required STRINGS — so a recovery keyed on schema-required strings could never fire on the
// one tool whose conditional the guard had just learned to enforce → guaranteed hard-refuse where fallback matters.
test('#EMPTY-GUARD GAP A: a conditionally-required field is ALSO recovery-eligible', () => {
  const r = guardArgs(byName('resolve_escalation'), { id: 7, message: 'here is my answer' })
  assert.equal(r.ok, true)
  assert.equal(r.args.answer, 'here is my answer')
  assert.deepEqual(r.recovered, { from: 'message', to: 'answer' })
})

// R1: predicate and handler must branch through ONE function or they can disagree on e.g. escalate:"true".
test('#EMPTY-GUARD R1: isEscalate is the single branch definition, shared by predicate and handler', () => {
  assert.equal(isEscalate({ escalate: true }), true)
  assert.equal(isEscalate({ escalate: false }), false)
  assert.equal(isEscalate({}), false)
  const t = byName('resolve_escalation')
  assert.equal(t.requireNonEmpty.answer({ escalate: true }), false)
  assert.equal(t.requireNonEmpty.answer({}), true)
})

// ── The general no-validation class: presence + type, coerce-then-refuse ───────────────────────────────────────────
test('#EMPTY-GUARD: a missing required field is named, not silently NaN’d downstream', () => {
  const r = guardArgs(byName('resolve_escalation'), { answer: 'x' })   // no id → was Number(undefined)=NaN → "no such escalation"
  assert.equal(r.ok, false)
  assert.match(r.error, /"id" is missing/)
})

test('#EMPTY-GUARD: numeric strings COERCE (matches the handler’s own Number(), cannot regress a working call)', () => {
  const r = guardArgs(byName('resolve_escalation'), { id: '7', answer: 'ok' })
  assert.equal(r.ok, true)
  assert.equal(r.args.id, 7)
})

// DEFECT 2: booleans are deliberately NOT coerced. `!!"false"` is true, so `{escalate:"false"}` escalates TODAY;
// coercing it to false would flip the branch, make `answer` conditionally required, and could refuse the call —
// a behavior change on the human's backstop smuggled into a reliability fix. Status quo stands; isEscalate is the
// single definition. (The "false"-means-true quirk is real and ticketed separately.)
test('#EMPTY-GUARD DEFECT 2: escalate is NOT coerced — the branch stays exactly as the handler reads it', () => {
  const r = guardArgs(byName('resolve_escalation'), { id: 7, escalate: 'false' })
  assert.equal(r.ok, true)
  assert.equal(r.args.escalate, 'false', 'raw value preserved — no silent branch flip')
  assert.equal(isEscalate(r.args), true, 'still escalates, exactly as before this fix')
})

test('#EMPTY-GUARD: an unusable type is refused with a named field', () => {
  const r = validateAndCoerce(byName('resolve_escalation'), { id: 'not-a-number', answer: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /"id" must be a number/)
})

// Body-role scoping: a path must be given deliberately, never inferred from a stray `message` key.
test('#EMPTY-GUARD: alias recovery never fills a NON-body required field (send_photo.path)', () => {
  // `path` is NON-body, so presence applies to it (unlike a body field, which defers to recovery per DEFECT 1).
  // Either way the invariant that matters holds: a path is NEVER inferred from a stray key.
  const r = guardArgs(byName('send_photo'), { message: 'assets/cat.png' })
  assert.equal(r.ok, false)
  assert.match(r.error, /"path"/)
  assert.equal(r.args, undefined, 'path must never be recovered from an aliased key')
})

// A throwing predicate must degrade to a visible refusal, never take down the CallTool handler.
test('#EMPTY-GUARD: a throwing requireNonEmpty predicate fails CLOSED', () => {
  const rogue = { name: 'rogue', inputSchema: { type: 'object', properties: { body: { type: 'string' } }, required: [] },
    requireNonEmpty: { body: () => { throw new Error('boom') } } }
  assert.ok(effectivelyRequired(rogue, {}).includes('body'))
  assert.equal(guardArgs(rogue, {}).ok, false)
})

// ask_user builds `@user ${text}` — an empty body becomes "@user " (length 6). The guard must see the RAW field,
// which it does by running at the CallTool door BEFORE the prefix is glued on.
test('#EMPTY-GUARD: ask_user empty body is caught on the RAW field, pre-prefix', () => {
  const r = guardArgs(byName('ask_user'), { text: '  ' })
  assert.equal(r.ok, false)
  assert.match(r.error, /"text"/)
})

// ── The regression this file was almost undone by (Pierre: green units are necessary, NOT sufficient) ──────────────
// The tool table was extracted into mrc-channel-tools.js and the server rewired to import from it. `node --check` is
// single-file; the unit tests import the TOOLS module directly and never load the SERVER (it imports the MCP SDK,
// absent on the host). So a broken cross-module import in the server — importing a name the tools module doesn't
// export — was invisible to every host check, yet it's an ESM LINK-TIME error that crashes the channel server at
// startup (plugin:room:room → "failed") for EVERY session. That actually shipped (NON_BODY_FIELDS, removed by the
// opt-in flip but still imported). This test statically parses the server's import and asserts every name resolves,
// closing that class without needing the SDK or a container.
test('#EMPTY-GUARD: every name the channel server imports from mrc-channel-tools.js is actually exported', async () => {
  const { readFileSync } = await import('node:fs')
  const server = readFileSync(new URL('../container/mrc-channel-server.js', import.meta.url), 'utf8')
  const tools = readFileSync(new URL('../container/mrc-channel-tools.js', import.meta.url), 'utf8')
  // [^{}] so the capture can't span from an earlier `import {…}` into this one (each import has its own braces).
  const m = server.match(/import\s*\{([^{}]*?)\}\s*from\s*['"]\.\/mrc-channel-tools\.js['"]/)
  assert.ok(m, 'the server must import from ./mrc-channel-tools.js')
  const imported = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
  const exported = new Set([...tools.matchAll(/^export\s+(?:const|function|let|class)\s+([A-Za-z0-9_$]+)/gm)].map((x) => x[1]))
  const missing = imported.filter((n) => !exported.has(n))
  assert.deepEqual(missing, [], `the server imports name(s) not exported by mrc-channel-tools.js: ${missing.join(', ')} — ESM link error, crashes the channel server at startup`)
})
