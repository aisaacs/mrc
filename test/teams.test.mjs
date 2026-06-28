// Host-side unit tests for the team foundation (names, personas, roster). Run: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickFirstName, makeHandle, parseMention, extractMentions, stripMentions, backendFamily, FRENCH_NAMES } from '../src/teams/names.js'
import { buildPersona, roleDef, ROLES } from '../src/teams/personas.js'
import { parseRoster, validateRoster, teamRoomId, leadsRoomId } from '../src/teams/roster.js'
import { classifyTerminal } from '../src/commands/team.js'

// Deterministic RNG for reproducible name draws.
function seededRng(seed = 1) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000 }
}

test('names: handles are first/backend, lowercased', () => {
  assert.equal(makeHandle('Ludivine', 'Claude'), 'ludivine/claude')
  assert.equal(makeHandle('Thierry', 'codex'), 'thierry/codex')
  assert.equal(backendFamily('GPT-Codex'), 'gptcodex')
})

test('names: pickFirstName avoids taken names and is unique across a draw', () => {
  const taken = new Set()
  const rng = seededRng(42)
  const picks = []
  for (let i = 0; i < 20; i++) { const n = pickFirstName(taken, rng); taken.add(n.toLowerCase()); picks.push(n) }
  assert.equal(new Set(picks.map((p) => p.toLowerCase())).size, 20, 'all picks unique')
})

test('names: pool exhaustion falls back to numbered names without throwing', () => {
  const taken = new Set(FRENCH_NAMES.map((n) => n.toLowerCase()))
  const n = pickFirstName(taken, seededRng(7))
  assert.ok(n && !taken.has(n.toLowerCase()))
})

test('names: parseMention + extractMentions', () => {
  assert.deepEqual(parseMention('@Ludivine/Claude'), { first: 'ludivine', backend: 'claude' })
  assert.deepEqual(parseMention('thierry'), { first: 'thierry', backend: null })
  assert.deepEqual(extractMentions('hey @critic and @ludivine/claude, also @user pls'),
    ['critic', 'ludivine/claude', 'user'])
  assert.deepEqual(extractMentions('no mentions here'), [])
})

test('names: extractMentions captures accented French handles in full', () => {
  // The whole point of the French/Spaceballs pool — an ASCII-only matcher truncated these.
  assert.deepEqual(extractMentions('@Côme @Médor @Dorothée @Hélène @Étienne @Rémy @Mégane'),
    ['côme', 'médor', 'dorothée', 'hélène', 'étienne', 'rémy', 'mégane'])
  assert.deepEqual(extractMentions('@Côme/claude please'), ['côme/claude'])
})

test('names: extractMentions trims trailing punctuation and ignores emails / mid-word @', () => {
  // Sentence-final names must still resolve, and critically @user. must still reach the human.
  assert.deepEqual(extractMentions('thanks @Roland. and @user.'), ['roland', 'user'])
  assert.deepEqual(extractMentions('ping @brigitte, @apolline!'), ['brigitte', 'apolline'])
  // An email in prose is not a mention; a mid-word @ is not either.
  assert.deepEqual(extractMentions('email a@b.com, ask @user not foo@bar'), ['user'])
})

test('names: stripMentions removes addressees regardless of case or accents', () => {
  assert.equal(stripMentions('@Côme make a neon diner logo'), 'make a neon diner logo')
  assert.equal(stripMentions('@designer @Côme/claude  punchy 8-bit title'), 'punchy 8-bit title')
  assert.equal(stripMentions('no handles at all'), 'no handles at all')
})

test('personas: every role has a mandate and a mount/tier', () => {
  for (const [name, def] of Object.entries(ROLES)) {
    assert.ok(def.mandate.length > 20, `${name} has a mandate`)
    assert.ok(['ro', 'rw'].includes(def.mount))
    assert.ok(['live', 'worker'].includes(def.tier))
  }
  assert.equal(roleDef('engineer').mount, 'rw')
  assert.equal(roleDef('architect').mount, 'ro')
  assert.equal(roleDef('nonsense').label, 'nonsense')   // generic fallback
})

test('personas: buildPersona injects identity, addressing, trust, territory, commit rule', () => {
  const roster = [
    { first: 'Roland', handle: 'roland/claude', roleLabel: 'Architect', lead: true },
    { first: 'Ludivine', handle: 'ludivine/claude', roleLabel: 'Engineer', lead: false },
  ]
  const p = buildPersona({
    self: { first: 'Ludivine', handle: 'ludivine/claude', roleLabel: 'Engineer' },
    team: 'client', roster, isLead: false, territory: 'client/src', mount: 'rw', role: 'engineer',
  })
  assert.match(p, /You are @Ludivine/)
  assert.match(p, /the Engineer on the "client" team/)
  assert.match(p, /@roland/)                     // teammate listed
  assert.match(p, /DIRECTED DELIVERY/)
  assert.match(p, /\[Human directive\]/)         // trust model
  assert.match(p, /client\/src/)                 // territory
  assert.match(p, /Do NOT run `git commit`/)     // human commits
  assert.match(p, /you may EDIT/)                // rw mount
})

test('personas: lead gets the leads-room instruction; non-lead does not', () => {
  const self = { first: 'Roland', handle: 'roland/claude', roleLabel: 'Architect' }
  const lead = buildPersona({ self, team: 'api', roster: [self], isLead: true, territory: '.', mount: 'ro', role: 'architect' })
  const member = buildPersona({ self, team: 'api', roster: [self], isLead: false, territory: '.', mount: 'ro', role: 'architect' })
  assert.match(lead, /LEADS room/)
  assert.doesNotMatch(member, /LEADS room/)
  assert.match(member, /ask your architect/)
})

test('roster: parses a two-team org and assigns unique handles', () => {
  const json = {
    org: 'shop', repo: '/tmp/shop',
    teams: [
      { name: 'client', territory: 'client', members: [
        { role: 'architect', backend: 'claude', lead: true },
        { role: 'engineer', backend: 'claude' },
        { role: 'critic', backend: 'codex' },
      ]},
      { name: 'api', territory: 'api', members: [
        { role: 'architect', backend: 'claude', lead: true },
        { role: 'engineer', backend: 'codex' },
      ]},
    ],
  }
  const norm = parseRoster(json, { rng: seededRng(3) })
  assert.equal(norm.org, 'shop')
  assert.equal(norm.members.length, 5)
  const handles = norm.members.map((m) => m.handle)
  assert.equal(new Set(handles).size, 5, 'handles unique across org')

  // tiers: claude => live, non-claude agent backends (codex) forced to worker
  const codexMembers = norm.members.filter((m) => m.backend === 'codex')
  assert.equal(codexMembers.length, 2)
  for (const m of codexMembers) assert.equal(m.tier, 'worker')
  assert.equal(norm.members.find((m) => m.role === 'architect').tier, 'live')

  // mounts: engineer rw, others ro
  assert.equal(norm.members.find((m) => m.role === 'engineer' && m.team === 'client').mount, 'rw')
  assert.equal(norm.members.find((m) => m.role === 'critic').mount, 'ro')

  // territory resolution
  assert.equal(norm.members.find((m) => m.team === 'api' && m.mount === 'rw').territory, 'api')
})

test('roster: derives team rooms + a leads room with @user', () => {
  const json = {
    org: 'shop',
    teams: [
      { name: 'client', members: [ { role: 'architect', lead: true }, { role: 'engineer' } ] },
      { name: 'api', members: [ { role: 'architect', lead: true }, { role: 'engineer' } ] },
    ],
  }
  const norm = parseRoster(json, { repo: '/tmp/shop', rng: seededRng(9) })
  const teamRooms = norm.rooms.filter((r) => r.kind === 'team')
  const leads = norm.rooms.find((r) => r.kind === 'leads')
  assert.equal(teamRooms.length, 2)
  assert.equal(teamRooms[0].roomId, teamRoomId('shop', 'client'))
  assert.ok(leads, 'leads room exists')
  assert.equal(leads.roomId, leadsRoomId('shop'))
  assert.ok(leads.members.includes('@user'))
  assert.equal(leads.members.filter((m) => m !== '@user').length, 2, 'both leads in the leads room')
})

test('roster: exactly one lead per team, auto-designated when unset', () => {
  const json = { org: 'x', teams: [ { name: 't', members: [ { role: 'engineer' }, { role: 'architect' }, { role: 'critic' } ] } ] }
  const norm = parseRoster(json, { repo: '/tmp/x', rng: seededRng(2) })
  const leads = norm.members.filter((m) => m.lead)
  assert.equal(leads.length, 1)
  assert.equal(leads[0].role, 'architect', 'architect auto-designated lead')
})

test('roster: validate flags overlapping write territories', () => {
  const json = { org: 'x', teams: [ { name: 't', territory: '.', members: [
    { role: 'engineer', name: 'aa', territory: 'src' },
    { role: 'engineer', name: 'bb', territory: 'src/deep' },
  ] } ] }
  const norm = parseRoster(json, { repo: '/tmp/x', rng: seededRng(2) })
  const v = validateRoster(norm)
  assert.ok(v.warnings.some((w) => /write territory/.test(w)), 'overlap warned')
})

test('roster: media roles DERIVE their backend from the role, ignoring the declared field (#32)', () => {
  const json = { org: 'm', teams: [ { name: 't', territory: '.', members: [
    { role: 'architect', name: 'lead', lead: true },
    { role: 'designer', name: 'dee', backend: 'claude' },        // declared claude — must be overridden
    { role: 'sound-designer', name: 'ess' },
    { role: 'composer', name: 'cee', backend: 'codex' },         // declared codex — must be overridden
  ] } ] }
  const norm = parseRoster(json, { repo: '/tmp/m', rng: seededRng(4) })
  const by = (r) => norm.members.find((m) => m.role === r)
  assert.equal(by('designer').backend, 'gemini')
  assert.equal(by('sound-designer').backend, 'elevenlabs')
  assert.equal(by('composer').backend, 'elevenlabs')
  // and the handle reflects the derived backend (first/backend)
  assert.match(by('designer').handle, /\/gemini$/)
  // the override of a wrongly-declared media backend is surfaced, not silent (Roland's note)
  const w = validateRoster(norm).warnings
  assert.ok(w.some((x) => /declared backend "claude" ignored.*media role "designer" uses "gemini"/.test(x)))
  assert.ok(w.some((x) => /declared backend "codex" ignored.*media role "composer" uses "elevenlabs"/.test(x)))
  assert.equal(by('sound-designer').backendNote, undefined, 'no note when nothing was declared')
})

test('roster: an agent role with a non-claude/codex backend is WARNED (kept, not coerced) (#32)', () => {
  const json = { org: 'a', teams: [ { name: 't', territory: '.', members: [
    { role: 'architect', name: 'lead', lead: true },
    { role: 'engineer', name: 'qq', backend: 'qwen' },     // qwen dropped — not an agent backend
    { role: 'critic', name: 'gg', backend: 'gemini' },     // gemini is media-only — invalid for an agent role
    { role: 'researcher', name: 'cc', backend: 'codex' },  // valid
  ] } ] }
  const norm = parseRoster(json, { repo: '/tmp/a', rng: seededRng(5) })
  const by = (r) => norm.members.find((m) => m.role === r)
  // warn-only: the declared backend is kept (coercing would be its own silent rewrite); the builder
  // constrains creation, validation flags a hand-written one.
  assert.equal(by('engineer').backend, 'qwen')
  assert.equal(by('critic').backend, 'gemini')
  assert.equal(by('researcher').backend, 'codex', 'a valid agent backend is kept, no note')
  const v = validateRoster(norm)
  assert.ok(v.warnings.some((w) => /@qq\/qwen: backend "qwen" is not a supported agent backend for role "engineer"/.test(w)))
  assert.ok(v.warnings.some((w) => /@gg\/gemini: backend "gemini" is not a supported agent backend for role "critic"/.test(w)))
  assert.equal(by('researcher').backendNote, undefined, 'codex agent gets no note')
})

test('roster: names are deterministic across runs (no rng passed) so members rebind', () => {
  const json = { org: 'shop', teams: [
    { name: 'client', members: [ { role: 'architect', backend: 'claude', lead: true }, { role: 'engineer', backend: 'claude' } ] },
    { name: 'api', members: [ { role: 'architect', backend: 'claude', lead: true } ] },
  ] }
  const a = parseRoster(json, { repo: '/tmp/shop' }).members.map((m) => m.handle)
  const b = parseRoster(json, { repo: '/tmp/shop' }).members.map((m) => m.handle)
  assert.deepEqual(a, b, 'same roster -> same handles every run')
  assert.equal(new Set(a).size, a.length, 'still unique')
})

test('roster: "project" is the friendly alias for "org"', () => {
  const norm = parseRoster({ project: 'shop', teams: [{ name: 't', members: [{ role: 'architect', backend: 'claude', lead: true }] }] }, { repo: '/tmp/x' })
  assert.equal(norm.org, 'shop')
})

test('roster: "qa" role aliases to the tester role', () => {
  const norm = parseRoster({ org: 'x', teams: [{ name: 't', members: [
    { role: 'architect', backend: 'claude', lead: true }, { role: 'qa', backend: 'claude' },
  ] }] }, { repo: '/tmp/x' })
  const qa = norm.members.find((m) => m.role === 'tester')
  assert.ok(qa, 'qa normalized to tester')
  assert.equal(qa.roleLabel, 'Tester')
})

test('roster: territory escaping the repo is rejected', () => {
  const json = { org: 'x', teams: [ { name: 't', territory: '../evil', members: [ { role: 'engineer' } ] } ] }
  assert.throws(() => parseRoster(json, { repo: '/tmp/x', rng: seededRng(2) }), /escapes the repo/)
})

test('roster: rejects crafted/unsafe pinned member names at parse (#36 defense-in-depth)', () => {
  // Roland's 4 confirmed shq payloads + shell/path metachar classes — ALL must REJECT at the parse
  // boundary, before the name reaches the sh -c launch, the dtach socket path, or a docker label.
  // REJECT (not strip) so two crafted names can't collapse to one handle (a registry/sock collision).
  const bad = [
    "'; touch /tmp/x", '$(touch /tmp/x)', '`touch /tmp/x`', '; touch /tmp/x',   // the shq payloads
    'a/b', '../etc', '.hidden',                                                  // path metachars
    'has space', "d'arcy", 'a"b', 'a;b', 'a|b', 'a$b', 'a&b', 'a`b', 'a>b',      // shell metachars / spaces / quotes
    '-lead', 'x-',                                                               // leading/trailing hyphen
  ]
  for (const name of bad) {
    const json = { org: 'x', teams: [{ name: 't', members: [{ role: 'engineer', name }] }] }
    assert.throws(() => parseRoster(json, { repo: '/tmp/x' }), /is invalid/, `should reject ${JSON.stringify(name)}`)
  }
})

test('roster: accepts accented/hyphenated names; empty or absent name auto-assigns (#36)', () => {
  for (const name of ['côme', 'jean-luc', 'René', 'agent2', 'Ludivine', 'a']) {
    assert.doesNotThrow(() => parseRoster({ org: 'x', teams: [{ name: 't', members: [{ role: 'engineer', name }] }] }, { repo: '/tmp/x' }), `should accept ${name}`)
  }
  // empty-string or absent name means "auto-assign", NOT a rejection
  const norm = parseRoster({ org: 'x', teams: [{ name: 't', members: [{ role: 'engineer', name: '' }, { role: 'critic' }] }] }, { repo: '/tmp/x', rng: seededRng(1) })
  assert.equal(norm.members.length, 2)
})

test('terminal state machine (#41): fail-toward-starting, evidence-gated orphaned', () => {
  // A sock that does not exist + no live master/ttyd → not servable, no (b)-fingerprint. So these cases
  // exercise the decision tree's establishment logic (the host-fact-independent half; serve / live-master
  // (b)-fingerprint need a real dtach and are container-path-verified).
  const info = { sock: '/tmp/__mrc_nonexistent_test.dtach', ttydPort: 7681 }
  // no container: within grace → building (image build / first run, fail-toward-starting); past grace → dead
  assert.equal(classifyTerminal(info, { containerAlive: false, online: true, withinGrace: true }), 'building')
  assert.equal(classifyTerminal(info, { containerAlive: false, online: true, withinGrace: false }), 'dead')
  // FAIL-TOWARD-STARTING: container up, not servable, not online, within grace → starting (never orphaned)
  assert.equal(classifyTerminal(info, { containerAlive: true, online: false, withinGrace: true }), 'starting')
  // online is restart-durable establishment evidence → orphaned even within grace
  assert.equal(classifyTerminal(info, { containerAlive: true, online: true, withinGrace: true }), 'orphaned')
  // past the build grace → established → orphaned
  assert.equal(classifyTerminal(info, { containerAlive: true, online: false, withinGrace: false }), 'orphaned')
  // a member mid-spawn (no committed sock) within grace is STARTING, not a false (b)-fingerprint
  assert.equal(classifyTerminal({ ttydPort: 7681 }, { containerAlive: true, online: false, withinGrace: true }), 'starting')
  // inconclusive default → starting, never orphaned
  assert.equal(classifyTerminal({}, { containerAlive: true, withinGrace: true }), 'starting')
})
