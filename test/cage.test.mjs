// #49 (4b) — cage profiles: the reusable, default-deny cage factored out of mrc.js's inline bundle.
// Covers the profile registry + allow-list, the parser gate (worker/unknown reject), applyCage's dial→flag
// mapping, THE record-bug fix (a caged member records adversary:true, never false), and the golden-diff
// anchor (the cage contribution depends only on (profile, ctx) — no summon-vs-member branch, so member ≡
// summon by construction). The container-lifetime BEHAVIOR (fails-closed, reap) is Inc 2/3 + a wire rebuild.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CAGE_PROFILES, resolveCageProfile, assertCageAllowed, applyCage, applyCageDials, sealFreshness, deriveEgressToken } from '../src/teams/cage.js'
import { parseRoster } from '../src/teams/roster.js'

const CTX = {
  repoPath: '/home/me/proj', nonce: 'abc123nonce', secret: 'S3CR3T', sealPort: 9443,
  loginVolume: 'mrc-config-deadbeef-pierre-1', summonedBy: 'issuer-uuid',
}

test('registry: dual-axis readiness table — adversary ready both axes, the looser tier present but classifier:false', () => {
  assert.equal(CAGE_PROFILES.adversary.ready.transport, true)
  assert.equal(CAGE_PROFILES.adversary.ready.classifier, true)
  // The middle tier is PHYSICALLY present (complete table + test-exercisable dials) but classifier:false.
  assert.equal(CAGE_PROFILES.contained.ready.transport, true)
  assert.equal(CAGE_PROFILES.contained.ready.classifier, false)
})

test('resolveCageProfile: the single mint gate — adversary mints, the un-ready tier does NOT, unknown throws', () => {
  assert.equal(resolveCageProfile('adversary').name, 'adversary')
  // `contained` exists in the table but is UN-MINTABLE (classifier not ready) — no caller can instantiate it.
  assert.throws(() => resolveCageProfile('contained'), /not shippable yet/)
  assert.throws(() => resolveCageProfile('whitelist'), /unknown cage profile/)
})

test('applyCageDials generalizes: the looser tier produces NO seal and does NOT set the adversary keystone', () => {
  // Exercise the translator directly on the un-mintable `contained` profile — proving applyCageDials reads
  // dials generically, not adversary-hardcoded, AND that this tier records NO adversary:true (which is exactly
  // why it must stay un-mintable until classifyContainment is 3-valued). { allowUnready:true } is the loud,
  // greppable, TEST-ONLY declaration — production launch code can never write it by accident.
  const c = applyCageDials(CAGE_PROFILES.contained, CTX, { allowUnready: true })
  assert.equal(c.sealSpec, null, 'whitelist egress uses the in-container firewall, no host seal')
  assert.ok(!c.envFlags.join(' ').includes('MRC_ADVERSARY=1'))
  assert.notEqual(c.recordFields.adversary, true, 'the looser tier is NOT recorded as adversary')
  assert.equal(c.recordFields.cageProfile, 'contained')
  assert.ok(!c.labels.join(' ').includes('mrc.adversary=1'), 'no adversary label on a non-adversary cage')
})

test('the SECOND mint door is closed: applyCageDials REFUSES an unready profile without the test-only flag', () => {
  // The footgun Pierre named: applyCageDials(CAGE_PROFILES.contained, ctx) from any importer would otherwise
  // mint an unready cage recording adversary:false → 'normal' (silent uncage). Without allowUnready it throws.
  assert.throws(() => applyCageDials(CAGE_PROFILES.contained, CTX), /refused an unready cage profile/)
  // A READY profile translates fine without the flag (applyCage's normal, already-gated path).
  assert.doesNotThrow(() => applyCageDials(CAGE_PROFILES.adversary, CTX))
})

test('assertCageAllowed: reject a host-enforced cage on a non-claude backend (worker cannot seal)', () => {
  assert.equal(assertCageAllowed('adversary', 'claude').ok, true)
  const codex = assertCageAllowed('adversary', 'codex')
  assert.equal(codex.ok, false)
  assert.match(codex.error, /only a live claude member can carry/)
  assert.equal(assertCageAllowed('bogus', 'claude').ok, false)
})

test('applyCage(adversary): maps every dial to the expected cage flags', () => {
  const c = applyCage('adversary', CTX)
  // workspace ro
  assert.ok(c.volumes.join(' ').includes(`${CTX.repoPath}:/workspace:ro`))
  // login slot volume (claude only — no codex volume ever)
  assert.ok(c.volumes.join(' ').includes(`${CTX.loginVolume}:/home/coder/.claude`))
  assert.ok(!c.volumes.join(' ').includes('.codex'))
  // egress: SNI sidecar, client-authed proxy URL carrying the DERIVED egress token (never the master secret)
  const env = c.envFlags.join(' ')
  const tok = deriveEgressToken(CTX.secret)
  assert.match(env, new RegExp(`HTTPS_PROXY=http://mrc:${tok}@host\\.docker\\.internal:9443`))
  assert.match(env, new RegExp(`https_proxy=http://mrc:${tok}@host\\.docker\\.internal:9443`))
  assert.ok(!env.includes(CTX.secret), 'the MASTER secret NEVER appears in the proxy URL (only the derived token)')
  assert.ok(env.includes('MRC_ADVERSARY_FW=1'))
  assert.ok(env.includes('MRC_ADVERSARY=1'))
  // sidecar seal spec (spawned by the launcher, not here) — carries the derived token, not the master secret
  assert.equal(c.sealSpec.needed, true)
  assert.equal(c.sealSpec.nonce, CTX.nonce)
  assert.equal(c.sealSpec.token, tok)
  assert.notEqual(c.sealSpec.token, CTX.secret)
  assert.equal(c.sealSpec.port, CTX.sealPort)
  assert.equal(c.sealSpec.freshness, sealFreshness(CTX.nonce, CTX.secret))
  // host bridges blocked; reap label keyed on the nonce
  assert.equal(c.hostBridges.clipboard, false)
  assert.equal(c.hostBridges.notify, false)
  assert.ok(c.labels.join(' ').includes(`mrc.seal=${CTX.nonce}`))
  assert.equal(c.workspaceRo, true)
})

test('THE FIX: a caged member records adversary:true (never the adversary:false that classified Pierre normal)', () => {
  const c = applyCage('adversary', CTX)
  assert.equal(c.recordFields.adversary, true, 'the keystone is derived from the profile, not a boolean off the member branch')
  assert.equal(c.recordFields.cageProfile, 'adversary')
  assert.equal(c.recordFields.summonedBy, 'issuer-uuid')
})

test('golden-diff anchor: the cage contribution depends only on (profile, ctx) — member ≡ summon by construction', () => {
  // applyCage has NO summon-vs-member branch, so two calls with equal resolved ctx yield IDENTICAL flags.
  // This is the structural guarantee behind "the strict adversary profile reproduces the cage identically on
  // both paths" — the launcher feeds the same resolved inputs, and the cage output can't diverge by caller.
  const asSummon = applyCage('adversary', { ...CTX })
  const asMember = applyCage('adversary', { ...CTX })
  assert.deepEqual(asSummon.volumes, asMember.volumes)
  assert.deepEqual(asSummon.envFlags, asMember.envFlags)
  assert.deepEqual(asSummon.labels, asMember.labels)
  assert.deepEqual(asSummon.recordFields, asMember.recordFields)
})

// --- parser gate through parseRoster ----------------------------------------
test('parser gate: cage:adversary on a claude member is accepted and normalized onto the member', () => {
  const norm = parseRoster({ teams: [{ name: 't', members: [
    { name: 'archie', role: 'architect', backend: 'claude' },
    { name: 'pierre', role: 'adversary', backend: 'claude', cage: 'adversary' },
  ] }] }, { repo: '/tmp/r' })
  const caged = norm.members.find((m) => m.first === 'pierre')
  assert.equal(caged.cage, 'adversary')
})

test('parser gate: cage on a codex worker is REJECTED at parse (transport cannot seal it)', () => {
  assert.throws(() => parseRoster({ teams: [{ name: 't', members: [
    { name: 'archie', role: 'architect', backend: 'claude' },
    { name: 'wrk', role: 'critic', backend: 'codex', cage: 'adversary' },
  ] }] }, { repo: '/tmp/r' }), /only a live claude member can carry/)
})

test('parser gate: an unknown cage profile is REJECTED at parse', () => {
  assert.throws(() => parseRoster({ teams: [{ name: 't', members: [
    { name: 'x', role: 'engineer', backend: 'claude', cage: 'whitelist' },
  ] }] }, { repo: '/tmp/r' }), /unknown cage profile/)
})
