// Host-side unit tests for the team foundation (names, personas, roster). Run: node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import { pickFirstName, makeHandle, parseMention, extractMentions, stripMentions, backendFamily, FRENCH_NAMES, NAME_STYLES, NAME_STYLE_NAMES, GENERALIST_NAMES } from '../src/teams/names.js'
import { buildPersona, roleDef, ROLES } from '../src/teams/personas.js'
import { parseRoster, validateRoster, editPersona, assertSafeName, assertSafeProjectName, teamRoomId, leadsRoomId } from '../src/teams/roster.js'
import { classifyTerminal } from '../src/commands/team.js'
import { addAuthorizedRepo, _authPathForTest } from '../src/teams/repo-auth.js'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('names: #50 generalist auto-assign is deterministic + ORDERED (Claudine, Pascal, Solange, Guy), seed-independent', () => {
  assert.deepEqual(GENERALIST_NAMES, ['Claudine', 'Pascal', 'Solange', 'Guy'])
  // the Nth auto-assigned generalist is always the Nth name, regardless of the rng seed passed
  for (const seed of [1, 7, 42, 999]) {
    const taken = new Set(), picks = []
    for (let i = 0; i < 4; i++) { const n = pickFirstName(taken, seededRng(seed)); taken.add(n.toLowerCase()); picks.push(n) }
    assert.deepEqual(picks, GENERALIST_NAMES, `seed ${seed}: first four generalists are the deterministic list, in order`)
  }
  // every generalist name is a real French pool name (so pool-exhaustion + FRENCH_NAMES invariants hold)
  for (const n of GENERALIST_NAMES) assert.ok(FRENCH_NAMES.includes(n), `${n} ∈ FRENCH_NAMES`)
  // a chosen THEME is untouched — it keeps its themed pool, never the generalist list
  assert.ok(NAME_STYLES.italian.includes(pickFirstName(new Set(), seededRng(1), 'italian')))
  assert.ok(!GENERALIST_NAMES.includes(pickFirstName(new Set(), seededRng(1), 'spaceballs')))
  // past the list → falls through to the normal draw (still a valid french name, never throws)
  const taken = new Set(GENERALIST_NAMES.map((n) => n.toLowerCase()))
  const fifth = pickFirstName(taken, seededRng(3))
  assert.ok(FRENCH_NAMES.includes(fifth) && !GENERALIST_NAMES.includes(fifth))
})

test('names: pickFirstName draws from the requested style; unknown/custom falls back to french (#44)', () => {
  assert.ok(NAME_STYLES.spaceballs.includes(pickFirstName(new Set(), seededRng(1), 'spaceballs')))
  assert.ok(NAME_STYLES['far-west'].includes(pickFirstName(new Set(), seededRng(2), 'far-west')))
  assert.ok(NAME_STYLES.italian.includes(pickFirstName(new Set(), seededRng(5), 'italian')))
  // unknown OR custom style → the french pool (default + fallback)
  assert.ok(FRENCH_NAMES.includes(pickFirstName(new Set(), seededRng(3), 'nonsense')))
  assert.ok(FRENCH_NAMES.includes(pickFirstName(new Set(), seededRng(3), 'custom')))
  assert.ok(FRENCH_NAMES.includes(pickFirstName(new Set(), seededRng(4))))   // no style arg → french (roster.js back-compat)
  // collision-avoidance within a style; exhausted pool → numbered fallback, never throws
  const taken = new Set(NAME_STYLES.hitchhikers.map((n) => n.toLowerCase()))
  const out = pickFirstName(taken, seededRng(9), 'hitchhikers')
  assert.match(out, /\d$/); assert.ok(!taken.has(out.toLowerCase()))
})

test('names: every style-pool name is a valid handle (#36 assertSafeName), and custom+french are listed (#44)', () => {
  // call the REAL #36 guard (not a regex copy) so this tracks assertSafeName if it ever tightens
  for (const [style, pool] of Object.entries(NAME_STYLES)) for (const n of pool) assert.doesNotThrow(() => assertSafeName(n), `${style}/${n} must be a valid handle`)
  assert.ok(NAME_STYLE_NAMES.includes('custom') && NAME_STYLE_NAMES.includes('french'))
  assert.ok(!Object.prototype.hasOwnProperty.call(NAME_STYLES, 'custom'), 'custom has no pool (free-type)')
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

// --- #42 chunk A: custom personas (team.json top-level `personas`) ---

test('personas: roleDef resolves a custom persona ahead of built-ins; tier preference is live', () => {
  const cps = { advertiser: { label: 'Ad Strategist', mandate: 'You write the campaign brief.', mount: 'rw' } }
  const def = roleDef('advertiser', cps)
  assert.equal(def.label, 'Ad Strategist')
  assert.equal(def.mandate, 'You write the campaign brief.')
  assert.equal(def.mount, 'rw')
  assert.equal(def.tier, 'live')   // preference; backend derivation forces worker for non-claude
  assert.equal(def.custom, true)
  // a custom key may also OVERRIDE a built-in agent role
  assert.equal(roleDef('critic', { critic: { label: 'Mega Critic', mandate: 'x' } }).label, 'Mega Critic')
  // unknown + no custom → generic fallback (unchanged)
  assert.equal(roleDef('advertiser').label, 'advertiser')
})

test('roster: a custom-persona member carries personaDef (custom label+mandate) and roleLabel', () => {
  const json = JSON.stringify({ org: 'shop', personas: { advertiser: { label: 'Ad Strategist', mandate: 'Own the ad copy.' } },
    teams: [{ name: 'mkt', members: [{ role: 'advertiser', backend: 'claude', lead: true }] }] })
  const norm = parseRoster(json, { repo: '/tmp/shop', rng: seededRng(11) })
  const m = norm.members[0]
  assert.equal(m.role, 'advertiser')
  assert.equal(m.roleLabel, 'Ad Strategist')
  assert.equal(m.personaDef.label, 'Ad Strategist')
  assert.equal(m.personaDef.mandate, 'Own the ad copy.')
  assert.equal(m.personaDef.custom, true)
  assert.ok(norm.customPersonas.advertiser, 'customPersonas map is surfaced on the norm')
})

test('roster: tier is DERIVED from backend for custom roles — claude→live, codex→worker (#32)', () => {
  const personas = { advertiser: { mandate: 'ads' } }
  const live = parseRoster({ org: 'x', personas, teams: [{ name: 't', members: [{ role: 'advertiser', backend: 'claude' }] }] }, { repo: '/tmp/x', rng: seededRng(1) })
  assert.equal(live.members[0].tier, 'live')
  assert.equal(live.members[0].personaDef.tier, 'live')
  const worker = parseRoster({ org: 'x', personas, teams: [{ name: 't', members: [{ role: 'advertiser', backend: 'codex' }] }] }, { repo: '/tmp/x', rng: seededRng(1) })
  assert.equal(worker.members[0].tier, 'worker')
  assert.equal(worker.members[0].personaDef.tier, 'worker')
})

test('roster: live-ness is backend-decided — a claude member is ALWAYS live; codex/media are workers (#49)', () => {
  const tierOf = (json) => parseRoster(json, { repo: '/tmp/x', rng: seededRng(1) }).members[0].tier
  // claude + UNDEFINED role (generic-fallback tier:'worker') → live (the #49 bug: came up on-demand)
  assert.equal(tierOf({ org: 'x', teams: [{ name: 't', members: [{ role: 'ux-expert', backend: 'claude' }] }] }), 'live')
  // claude + a built-in worker-PREFERENCE role (researcher def.tier:'worker') → live — role tier no longer demotes claude
  assert.equal(tierOf({ org: 'x', teams: [{ name: 't', members: [{ role: 'researcher', backend: 'claude' }] }] }), 'live')
  // claude + custom persona → live; codex → worker; media role (derives gemini/elevenlabs) → worker
  assert.equal(tierOf({ org: 'x', personas: { ux: { mandate: 'design' } }, teams: [{ name: 't', members: [{ role: 'ux', backend: 'claude' }] }] }), 'live')
  assert.equal(tierOf({ org: 'x', teams: [{ name: 't', members: [{ role: 'engineer', backend: 'codex' }] }] }), 'worker')
  assert.equal(tierOf({ org: 'x', teams: [{ name: 't', members: [{ role: 'designer' }] }] }), 'worker')
})

test('roster: the generalist role (the plain-Claude default) is rw + live + lead, and NOT flagged unknown', () => {
  const norm = parseRoster({ org: 'x', teams: [{ name: 't', members: [{ role: 'generalist', backend: 'claude', name: 'Claude' }] }] }, { repo: '/tmp/x', rng: seededRng(1) })
  const m = norm.members[0]
  assert.equal(m.mount, 'rw')          // a plain agent must be able to WRITE its own repo (same boundary as the old engineer default)
  assert.equal(m.tier, 'live')          // claude → always live
  assert.equal(m.roleLabel, 'Claude')   // built-in label, not the generic role-string fallback
  assert.equal(m.lead, true)            // leadByDefault → the sole/first agent is its own lead
  assert.ok(!validateRoster(norm).warnings.some((w) => /unknown role/.test(w)))   // it's a known built-in now
})

test('roster: cwdFallback:false fails a repo-LESS non-Model-B parse closed; default (preview) stays tolerant (Pierre cwd landmine)', () => {
  const repoLess = { org: 'x', teams: [{ name: 't', members: [{ role: 'generalist', backend: 'claude', name: 'Claude' }] }] }
  // A LAUNCH parse (cwdFallback:false) with no repo → THROW, never fall back to the daemon's cwd.
  assert.throws(() => parseRoster(repoLess, { cwdFallback: false }), /a repo is required/)
  // A structure-only parse (preview/validate — the default) with no repo → tolerated (uses cwd, never mounts).
  assert.doesNotThrow(() => parseRoster(repoLess, {}))
  // With a real repo, cwdFallback:false is a no-op — the launch proceeds.
  assert.doesNotThrow(() => parseRoster({ ...repoLess, repo: '/tmp/x' }, { cwdFallback: false }))
})

test('deriveRooms §14 (Option 2): escalation room = all ★ + @user; team room per team ≥2 members; a/b/c invariants across topologies', () => {
  const parse = (teams) => parseRoster({ org: 'o', teams }, { repo: '/tmp/o', rng: seededRng(1) })
  const esc = (norm) => norm.rooms.find((r) => r.kind === 'leads')          // the escalation room (id/kind kept as "leads")
  const teamRooms = (norm) => norm.rooms.filter((r) => r.kind === 'team')
  const stars = (norm) => norm.members.filter((m) => m.lead).map((m) => m.handle)
  const M = (name, role, lead) => ({ name, role, backend: 'claude', ...(lead != null ? { lead } : {}) })

  // The three invariants Pierre checks on the diff, applied to EVERY topology below.
  const invariants = (norm, label) => {
    const e = esc(norm); assert.ok(e, `${label}: an escalation room exists`)
    const escMembers = e.members.filter((h) => h !== '@user')
    const starSet = new Set(stars(norm))
    // (a) escalation room members are EXACTLY the ★s — no non-★ leaks the human, none missing
    assert.deepEqual([...escMembers].sort(), [...starSet].sort(), `${label}: escalation members == ★s (a)`)
    assert.ok(e.members.includes('@user'), `${label}: @user seated in the escalation room`)
    // (b) NO @user in any team (coordination) room — the wall
    for (const tr of teamRooms(norm)) assert.ok(!tr.members.includes('@user'), `${label}: team room "${tr.team}" has no @user (b)`)
    // (c) ≥1 ★ — nobody is roomless / unable to reach the human
    assert.ok(starSet.size >= 1, `${label}: ≥1 ★ (c)`)
  }

  // 1. SOLO — 1 member, no explicit lead → defaulted ★; NO team room; escalation = [member, @user]
  const solo = parse([{ name: 't', members: [M('Claude', 'generalist')] }])
  assert.equal(teamRooms(solo).length, 0, 'solo: no team room (a team of one has no teammate)')
  assert.equal(stars(solo).length, 1, 'solo: the lone member is defaulted ★')
  invariants(solo, 'solo')

  // 2. HIERARCHICAL 1 team — architect★ + engineer + critic; team room of 3, escalation = [architect, @user]
  const hier = parse([{ name: 't', members: [M('Aa', 'architect'), M('Ee', 'engineer'), M('Cc', 'critic')] }])
  assert.equal(teamRooms(hier).length, 1, 'hier: one team room')
  assert.equal(teamRooms(hier)[0].members.length, 3, 'hier: team room holds all 3 (coordination)')
  assert.equal(stars(hier).length, 1, 'hier: exactly 1 ★ (architect default) — eng/crit escalate UP to it')
  invariants(hier, 'hier-1team')

  // 3. HIERARCHICAL 2 teams — the escalation room bridges both leads (lead-to-lead cross-team + @user)
  const two = parse([
    { name: 'client', members: [M('Ac', 'architect'), M('Ec', 'engineer')] },
    { name: 'server', members: [M('As', 'architect'), M('Es', 'engineer')] },
  ])
  assert.equal(teamRooms(two).length, 2, '2-team: two team rooms')
  assert.equal(stars(two).length, 2, '2-team: 2 ★ (one architect per team)')
  assert.equal(esc(two).members.filter((h) => h !== '@user').length, 2, '2-team: escalation room bridges both leads')
  invariants(two, 'hier-2team')

  // 4. FLAT 2-★ (Option 2, uniform) — both leads → a size-2 team room (they can just talk) + escalation [both, @user]
  const flat = parse([{ name: 't', members: [M('Client', 'generalist', true), M('Server', 'generalist', true)] }])
  assert.equal(stars(flat).length, 2, 'flat: both declared leads kept as ★')
  assert.equal(teamRooms(flat).length, 1, 'flat: a size-2 team room exists — SAME shape as any ≥2 team (no special-case)')
  assert.equal(teamRooms(flat)[0].members.length, 2, 'flat: team room = [client, server]')
  assert.equal(esc(flat).members.length, 3, 'flat: escalation room = [client, server, @user]')
  invariants(flat, 'flat-2star')

  // 5. 1-member NON-★ team — the roomless edge: the per-team default MUST make it ★ (not stranded)
  const lonely = parse([{ name: 't', members: [M('Solo', 'engineer', false)] }])
  assert.equal(stars(lonely).length, 1, 'lonely: per-team default fired → the lone non-★ member became ★')
  assert.ok(esc(lonely).members.includes(stars(lonely)[0]), 'lonely: it is in the escalation room, NOT roomless')
  assert.equal(teamRooms(lonely).length, 0, 'lonely: no team room (1 member)')
  invariants(lonely, 'lonely-was-nonstar')

  // 6. MULTIPLE explicit leads in one team are HONORED (not collapsed to one — the old one-lead forcing is gone)
  const multi = parse([{ name: 't', members: [M('Xx', 'engineer', true), M('Yy', 'engineer', true), M('Zz', 'engineer')] }])
  assert.equal(stars(multi).length, 2, 'multi: both declared leads kept (not forced to one)')
  assert.ok(!stars(multi).includes('zz/claude'), 'multi: the non-declared member stays non-★')
  invariants(multi, 'multi-lead')

  // 7. MULTIPLE ★ WITHIN ONE team [a★, b★, c, d] — the several-★-per-team primitive. Team room holds all 4
  //    (c/d can escalate to EITHER a or b, both share their team room); escalation room = [a, b, @user] only.
  const within = parse([{ name: 't', members: [M('Aa', 'engineer', true), M('Bb', 'engineer', true), M('Cc', 'engineer'), M('Dd', 'engineer')] }])
  assert.equal(stars(within).length, 2, 'within: 2 ★ (a, b)')
  assert.equal(teamRooms(within).length, 1, 'within: one team room')
  assert.equal(teamRooms(within)[0].members.length, 4, 'within: team room holds all 4 — c/d reach either ★ here')
  const wEsc = esc(within).members.filter((h) => h !== '@user')
  assert.deepEqual(wEsc.sort(), ['aa/claude', 'bb/claude'].sort(), 'within: escalation room = exactly the 2 ★s (c/d walled out)')
  invariants(within, 'multi-star-within-team')
})

test('roster: buildPersona emits the custom mandate via member.personaDef', () => {
  const json = JSON.stringify({ org: 'shop', personas: { advertiser: { label: 'Ad Strategist', mandate: 'SENTINEL-MANDATE-9f.' } },
    teams: [{ name: 'mkt', members: [{ role: 'advertiser', backend: 'claude' }] }] })
  const norm = parseRoster(json, { repo: '/tmp/shop', rng: seededRng(12) })
  const m = norm.members[0]
  const roster = norm.members.map((x) => ({ first: x.first, handle: x.handle, roleLabel: x.roleLabel, lead: x.lead }))
  const text = buildPersona({ self: { first: m.first, handle: m.handle, roleLabel: m.roleLabel }, team: m.team, roster, isLead: m.lead, territory: m.territory, mount: m.mount, role: m.role, personaDef: m.personaDef })
  assert.match(text, /SENTINEL-MANDATE-9f\./)
  assert.match(text, /YOUR ROLE — Ad Strategist:/)
})

test('roster: a custom role is NOT flagged unknown by validateRoster (warns only for truly unknown)', () => {
  const known = parseRoster({ org: 'x', personas: { advertiser: { mandate: 'ads' } },
    teams: [{ name: 't', members: [{ role: 'advertiser', backend: 'claude' }] }] }, { repo: '/tmp/x', rng: seededRng(1) })
  assert.ok(!validateRoster(known).warnings.some((w) => /unknown role/.test(w)))
  const unknown = parseRoster({ org: 'x', teams: [{ name: 't', members: [{ role: 'phantom', backend: 'claude' }] }] }, { repo: '/tmp/x', rng: seededRng(1) })
  assert.ok(validateRoster(unknown).warnings.some((w) => /unknown role "phantom"/.test(w)))
  assert.equal(unknown.members[0].roleLabel, 'phantom')   // generic fallback, still launches
})

test('roster: rejects crafted/unsafe persona keys and media-role redefinition (#36 + media built-in)', () => {
  for (const key of ['bad key', 'a/b', 'x;rm', '@evil', '../x', 'q"x']) {
    assert.throws(() => parseRoster({ org: 'x', personas: { [key]: { mandate: 'm' } }, teams: [{ name: 't', members: [{ role: 'engineer' }] }] }, { repo: '/tmp/x' }),
      /persona key .* is invalid/, `should reject persona key ${JSON.stringify(key)}`)
  }
  for (const media of ['designer', 'sound-designer', 'composer']) {
    assert.throws(() => parseRoster({ org: 'x', personas: { [media]: { mandate: 'm' } }, teams: [{ name: 't', members: [{ role: 'engineer' }] }] }, { repo: '/tmp/x' }),
      /may not be redefined/, `should reject media-role persona ${media}`)
  }
  // a key that IS a built-in alias would silently never resolve — reject it (foot-gun, same class)
  for (const alias of ['writer', 'qa']) {
    assert.throws(() => parseRoster({ org: 'x', personas: { [alias]: { mandate: 'm' } }, teams: [{ name: 't', members: [{ role: 'engineer' }] }] }, { repo: '/tmp/x' }),
      /collides with a built-in role alias/, `should reject alias persona key ${alias}`)
  }
  // a non-object personas block is a hard error
  assert.throws(() => parseRoster({ org: 'x', personas: [1, 2], teams: [{ name: 't', members: [{ role: 'engineer' }] }] }, { repo: '/tmp/x' }), /must be an object map/)
  // a charter-less persona is rejected at the boundary — the mandate IS the role's definition
  for (const bad of [{}, { mandate: '' }, { mandate: '   ' }, { label: 'X' }]) {
    assert.throws(() => parseRoster({ org: 'x', personas: { advertiser: bad }, teams: [{ name: 't', members: [{ role: 'engineer' }] }] }, { repo: '/tmp/x' }),
      /needs a non-empty "mandate"/, `should reject empty-mandate persona ${JSON.stringify(bad)}`)
  }
})

test('roster: a custom persona leadByDefault claims lead when no architect is present (#42)', () => {
  const json = { org: 'x', personas: { pm: { label: 'Project Manager', mandate: 'coordinate', leadByDefault: true } },
    teams: [{ name: 't', members: [{ role: 'engineer', backend: 'claude' }, { role: 'pm', backend: 'claude' }] }] }
  const lead = parseRoster(json, { repo: '/tmp/x', rng: seededRng(1) }).members.find((m) => m.lead)
  assert.equal(lead.role, 'pm')
  // architect still wins the tie when present → no behavior change for existing teams
  const json2 = { org: 'x', personas: { pm: { mandate: 'c', leadByDefault: true } },
    teams: [{ name: 't', members: [{ role: 'pm', backend: 'claude' }, { role: 'architect', backend: 'claude' }] }] }
  assert.equal(parseRoster(json2, { repo: '/tmp/x', rng: seededRng(2) }).members.find((m) => m.lead).role, 'architect')
})

// --- #42 chunk B: editPersona (the /api/personas validated mutate core) ---

test('editPersona: save adds a custom persona and the result still parses', () => {
  const base = { org: 'x', teams: [{ name: 't', members: [{ role: 'engineer', backend: 'claude' }] }] }
  const r = editPersona(base, { op: 'save', key: 'advertiser', persona: { label: 'Ad', mandate: 'write ads', mount: 'ro' } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.roster.personas.advertiser, { label: 'Ad', mandate: 'write ads', mount: 'ro' })
  // the returned roster is what gets written — confirm it round-trips through the parser cleanly
  assert.doesNotThrow(() => parseRoster(r.roster, {}))
  assert.equal(base.personas, undefined)   // input is not mutated
})

test('editPersona: rejects a save the parser would reject (bad/alias/media key) — single source of validation', () => {
  const base = { org: 'x', teams: [{ name: 't', members: [{ role: 'engineer' }] }] }
  assert.equal(editPersona(base, { op: 'save', key: 'bad key', persona: { mandate: 'm' } }).ok, false)
  assert.match(editPersona(base, { op: 'save', key: 'writer', persona: { mandate: 'm' } }).error, /collides with a built-in role alias/)
  assert.match(editPersona(base, { op: 'save', key: 'designer', persona: { mandate: 'm' } }).error, /may not be redefined/)
  assert.equal(editPersona(base, { op: 'save', key: 'advertiser', persona: 'nope' }).ok, false)   // non-object body
})

test('editPersona: remove drops an unused persona but REFUSES while a member references it', () => {
  const used = { org: 'x', personas: { advertiser: { mandate: 'ads' } },
    teams: [{ name: 't', members: [{ role: 'engineer' }, { role: 'advertiser', name: 'Zoe' }] }] }
  const refuse = editPersona(used, { op: 'remove', key: 'advertiser' })
  assert.equal(refuse.ok, false)
  assert.ok(refuse.usedBy.includes('Zoe'))
  assert.match(refuse.error, /still used by/)
  // once no member references it, removal succeeds and the result parses
  const free = { org: 'x', personas: { advertiser: { mandate: 'ads' } }, teams: [{ name: 't', members: [{ role: 'engineer' }] }] }
  const ok = editPersona(free, { op: 'remove', key: 'advertiser' })
  assert.equal(ok.ok, true)
  assert.equal(ok.roster.personas.advertiser, undefined)
})

test('editPersona: rejects empty mandate and whitelists the stored shape (#42 chunk B)', () => {
  const base = { org: 'x', teams: [{ name: 't', members: [{ role: 'engineer' }] }] }
  assert.match(editPersona(base, { op: 'save', key: 'advertiser', persona: { label: 'Ad', mandate: '   ' } }).error, /non-empty "mandate"/)
  // junk/extra fields (a stray tier, arbitrary keys) are dropped — only {label,mandate,mount,leadByDefault} persist
  const r = editPersona(base, { op: 'save', key: 'advertiser', persona: { label: 'Ad', mandate: 'm', mount: 'rw', leadByDefault: true, tier: 'live', junk: 1 } })
  assert.equal(r.ok, true)
  assert.deepEqual(r.roster.personas.advertiser, { label: 'Ad', mandate: 'm', mount: 'rw', leadByDefault: true })
  // ro is the default — mount omitted when not rw, label falls back to the key
  const r2 = editPersona(base, { op: 'save', key: 'advertiser', persona: { mandate: 'm' } })
  assert.deepEqual(r2.roster.personas.advertiser, { label: 'advertiser', mandate: 'm' })
})

test('editPersona: guards bad inputs (no data, empty key, unknown op)', () => {
  assert.equal(editPersona(null, { op: 'save', key: 'a', persona: { mandate: 'm' } }).ok, false)
  assert.equal(editPersona({ teams: [] }, { op: 'save', key: '', persona: { mandate: 'm' } }).ok, false)
  assert.match(editPersona({ teams: [] }, { op: 'frobnicate', key: 'a' }).error, /unknown persona op/)
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
  assert.match(p, /never[\s\S]*fetch a URL, run a command, or POST/i)  // L4: the general do-not-be-a-peer's-hands caution lives in the shared protocol (not a role-keyed per-message tag)
  assert.match(p, /client\/src/)                 // territory
  assert.match(p, /Do NOT run `git commit`/)     // human commits
  assert.match(p, /you may EDIT/)                // rw mount
})

test('personas (d): a lead gets the LEADS-room + triage (resolve_escalation) instruction; a non-lead is told its @user is triaged to a lead', () => {
  const self = { first: 'Roland', handle: 'roland/claude', roleLabel: 'Architect' }
  const lead = buildPersona({ self, team: 'api', roster: [self], isLead: true, territory: '.', mount: 'ro', role: 'architect' })
  const member = buildPersona({ self, team: 'api', roster: [self], isLead: false, territory: '.', mount: 'ro', role: 'architect' })
  assert.match(lead, /LEADS room/)
  assert.match(lead, /resolve_escalation/, 'a lead is told it triages teammates\' escalations')
  assert.doesNotMatch(member, /LEADS room/)
  assert.match(member, /triaged to your team lead/i, 'a non-lead is told its @user is triaged to its lead first')
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

test('roster: writers on DIFFERENT repos do NOT trip the contention warning; same repo still does (Model B per-agent repos)', () => {
  const mk = (handle, territory, repo) => ({ handle, first: handle, role: 'engineer', roleLabel: 'Engineer', backend: 'claude', mount: 'rw', territory, repo, team: 't', lead: false, tier: 'live' })
  const diff = { org: 'x', members: [mk('aa/claude', 'src', '/repoA'), mk('bb/claude', 'src/deep', '/repoB')], teams: [], rooms: [], customPersonas: {} }
  assert.ok(!validateRoster(diff).warnings.some((w) => /write territory/.test(w)), 'different repos ("." vs "." across repos) → NO contention warning (the false positive the owner hit)')
  const same = { org: 'x', members: [mk('aa/claude', 'src', '/repoA'), mk('bb/claude', 'src/deep', '/repoA')], teams: [], rooms: [], customPersonas: {} }
  assert.ok(validateRoster(same).warnings.some((w) => /write territory/.test(w)), 'same repo + overlapping territory → the warning is REAL, still fires')
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

test('roster: rejects a duplicate member handle ORG-WIDE across teams; distinct backend is allowed (#44-1)', () => {
  // two pinned same-name + same-backend members in DIFFERENT teams → identical handle → throw (org-wide,
  // not per-team — the dtach socket / docker label / launch registry key on org+handle, team-independent)
  const dup = { org: 'x', teams: [
    { name: 'a', members: [{ role: 'architect', backend: 'claude', name: 'Roland', lead: true }] },
    { name: 'b', members: [{ role: 'engineer', backend: 'claude', name: 'Roland' }] },
  ] }
  assert.throws(() => parseRoster(dup, { repo: '/tmp/x' }), /duplicate member handle "@roland\/claude"/)
  // same name but DIFFERENT backend → distinct handle → allowed
  const norm = parseRoster({ org: 'x', teams: [{ name: 't', members: [
    { role: 'architect', backend: 'claude', name: 'Roland', lead: true }, { role: 'critic', backend: 'codex', name: 'Roland' },
  ] }] }, { repo: '/tmp/x' })
  assert.deepEqual(norm.members.map((m) => m.handle), ['roland/claude', 'roland/codex'])
  // validateRoster ERRORs on a (hand-constructed) colliding norm too — defense-in-depth at both boundaries
  const v = validateRoster({ members: [{ handle: 'roland/claude', role: 'architect', mount: 'ro', backend: 'claude' }, { handle: 'roland/claude', role: 'critic', mount: 'ro', backend: 'claude' }] })
  assert.equal(v.ok, false)
  assert.ok(v.errors.some((e) => /duplicate member handle @roland\/claude/.test(e)))
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

// #65: the org/team-name allowlist validator (closes a live dashboard XSS via a malicious team.json
// `project` field). Allowlist (`\p{L}\p{N}` + literal space + . _ -) — complete-by-construction: rejects
// every HTML/JS metachar AND the Unicode line-terminators (literal space, NOT \s), while ACCEPTING readable
// accented/CJK names (#38 — no ASCII-only over-rejection, the @mention accent-trap).
test('#65 assertSafeProjectName: rejects breakout + unicode separators; accepts readable accented/spaced names', () => {
  const NBSP = String.fromCharCode(0xA0), LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029), IDS = String.fromCharCode(0x3000), BOM = String.fromCharCode(0xFEFF), NL = String.fromCharCode(10)
  // ACCEPT — readable, accented, CJK, spaced (the #38 anti-over-rejection direction)
  for (const g of ['My Project', 'Équipe Alpha', '项目', 'Café', 'São Paulo', 'app.v2', 'my_project', 'node-app', 'A1']) {
    assert.equal(assertSafeProjectName(g), g, `should accept readable name: ${g}`)
  }
  // REJECT — the exploit + every breakout char + the Unicode line-terminator class (proves literal-space, not \s)
  for (const bad of ["evil');alert(1)//", 'a<b', 'R&D', 'f(x)', 'a;b', 'a{b}', 'a`b', 'a"b', 'a' + NBSP + 'b', 'a' + LS + 'b', 'a' + PS + 'b', 'a' + IDS + 'b', 'a' + BOM + 'b', 'a' + NL + 'b', '-dash', '_under', '.dot', '', '   ']) {
    assert.throws(() => assertSafeProjectName(bad), /invalid|empty/, `should reject: ${JSON.stringify(bad)}`)
  }
  // leading/trailing whitespace is TRIMMED (user-friendly), not rejected
  assert.equal(assertSafeProjectName('  My Project  '), 'My Project')
})

test('#65 parseRoster: a malicious team.json project / team name is rejected at the parse chokepoint', () => {
  const evil = "x');alert(document.cookie)//"
  assert.throws(() => parseRoster({ project: evil, teams: [{ name: 'core', members: [{ role: 'architect', backend: 'claude', lead: true }] }] }), /invalid/, 'malicious project name rejected')
  assert.throws(() => parseRoster({ project: 'ok', teams: [{ name: evil, members: [{ role: 'architect', backend: 'claude', lead: true }] }] }), /invalid/, 'malicious team name rejected')
  // a clean readable project + team still parse
  const r = parseRoster({ project: 'My Project', teams: [{ name: 'Équipe A', members: [{ role: 'architect', backend: 'claude', lead: true }] }] })
  assert.equal(r.org, 'My Project')
})

// Inc 3 Site 2 — the Model B PARSE: every member needs an EXPLICIT, human-authorized repo (the authorized-set is
// the SOLE gate; no org-root default). modelB is threaded ONLY on the team launch path (materializeRoster, Site 5)
// and never for solo, so it's `storeMode && team && !solo` by construction. Legacy parse (modelB false) unchanged.
test('parseRoster Model B (Inc 3 Site 2): explicit authorized member.repo required; no org-root default; legacy unchanged', () => {
  const rootReal = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-mb-')))
  const repoA = join(rootReal, 'a'); mkdirSync(repoA)
  const repoB = join(rootReal, 'b'); mkdirSync(repoB)
  const org = `mb-${process.pid}-${Math.floor(process.hrtime()[1] % 1e6)}`
  const mk = (members) => ({ org, teams: [{ name: 't', members }] })
  try {
    // No member.repo under Model B → THROW (no org-root default to fall back to).
    assert.throws(() => parseRoster(mk([{ role: 'engineer', backend: 'claude' }]), { repo: repoA, modelB: true }), /choose its own repo/)
    // An UNAUTHORIZED member.repo → THROW (fail-closed — the set is empty).
    assert.throws(() => parseRoster(mk([{ role: 'engineer', backend: 'claude', repo: repoB }]), { repo: repoA, modelB: true }), /not authorized/)
    // A human authorizes repoB → parses; the member's repo is canonical repoB; crossRepo forced true (org-scoped).
    addAuthorizedRepo(org, repoB)
    const norm = parseRoster(mk([{ role: 'engineer', backend: 'claude', repo: repoB }]), { repo: repoA, modelB: true })
    assert.equal(norm.members[0].repo, repoB)
    assert.equal(norm.members[0].crossRepo, true, 'Model B: every member is org-scoped (no org-root proxy)')
    // LEGACY (modelB false) unchanged: no member.repo → defaults to the org repo (own-repo grant), crossRepo false.
    const legacy = parseRoster(mk([{ role: 'engineer', backend: 'claude' }]), { repo: repoA })
    assert.equal(legacy.members[0].repo, repoA)
    assert.equal(legacy.members[0].crossRepo, false)
  } finally { rmSync(rootReal, { recursive: true, force: true }); try { unlinkSync(_authPathForTest(org)) } catch {} }
})

// §14 CONTAINMENT parse-gates (the rebuild's create-form ad-hoc-rooms surface): the UI can express ★/rooms
// freely, but a hand-edited team.json (or a manual ad-hoc room) must not slip a containment breach past parse.
test('validateRoster gate (a): @user seated beside a non-★ member is REJECTED at parse (escalation wall)', () => {
  const base = { org: 'o', repo: '/tmp', teams: [], customPersonas: {} }
  // a MANUAL ad-hoc room composing @user next to a NON-★ engineer → leaks the human to a non-★ → reject
  const bad = validateRoster({ ...base,
    members: [{ handle: 'colette/claude', lead: true, role: 'architect' }, { handle: 'margaux/claude', lead: false, role: 'engineer' }],
    rooms: [{ roomId: 'r', kind: 'adhoc', members: ['colette/claude', 'margaux/claude', '@user'] }] })
  assert.ok(!bad.ok, 'a non-★ in an @user room is rejected')
  assert.ok(bad.errors.some((e) => /@user/.test(e) && /wall|non-★/.test(e)), 'the error names the wall breach')
  // @user seated ONLY with ★ members → OK (the derived-escalation shape)
  const good = validateRoster({ ...base,
    members: [{ handle: 'colette/claude', lead: true, role: 'architect' }, { handle: 'margaux/claude', lead: false, role: 'engineer' }],
    rooms: [{ roomId: 'r', kind: 'leads', members: ['colette/claude', '@user'] }] })
  assert.ok(good.ok, 'an @user room of only ★ passes')
})

test('validateRoster gate (b): an adversary/caged member carrying ★ (lead) is REJECTED at parse (§14 never-★)', () => {
  const base = { org: 'o', repo: '/tmp', teams: [], rooms: [], customPersonas: {} }
  const advStar = validateRoster({ ...base, members: [{ handle: 'pierre/claude', lead: true, role: 'adversary' }] })
  assert.ok(!advStar.ok && advStar.errors.some((e) => /adversary|never be ★/.test(e)), 'a ★-adversary is rejected')
  const cagedStar = validateRoster({ ...base, members: [{ handle: 'p/claude', lead: true, role: 'engineer', cage: 'contained' }] })
  assert.ok(!cagedStar.ok && cagedStar.errors.some((e) => /caged|never be ★/.test(e)), 'a ★-caged member is rejected')
  // an adversary that is NOT ★ → this gate does not fire
  const advOk = validateRoster({ ...base, members: [{ handle: 'pierre/claude', lead: false, role: 'adversary' }, { handle: 'a/claude', lead: true, role: 'architect' }] })
  assert.ok(!advOk.errors.some((e) => /never be ★/.test(e)), 'a non-★ adversary is fine by this gate')
})
