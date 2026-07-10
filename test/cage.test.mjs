// #49 (4b) — cage profiles: the reusable, default-deny cage factored out of mrc.js's inline bundle.
// Covers the profile registry + allow-list, the parser gate (worker/unknown reject), applyCage's dial→flag
// mapping, THE record-bug fix (a caged member records adversary:true, never false), and the golden-diff
// anchor (the cage contribution depends only on (profile, ctx) — no summon-vs-member branch, so member ≡
// summon by construction). The container-lifetime BEHAVIOR (fails-closed, reap) is Inc 2/3 + a wire rebuild.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CAGE_PROFILES, resolveCageProfile, assertCageAllowed, applyCage, applyCageDials, sealFreshness, deriveEgressToken, cageReadsRepoEnv, cagedRoomVolumes, resolvedVolIsUserLogin, memberCageLaunchGate, cageIsAdversary } from '../src/teams/cage.js'
import { parseRoster } from '../src/teams/roster.js'
import { memberRepoEnvKey } from '../src/config.js'
import { volumeName } from '../src/docker.js'
import { memberConfigVolName, execWorker } from '../src/commands/team.js'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

// ─── #49 cross-repo × cage — Q4: a caged member reads NO repo .env (kill-matrix item #2) ───
// The adversary profile carries repoEnv:'none'; cageReadsRepoEnv is the single decision source; config.memberRepoEnvKey
// is the mint every member-secret reader (execWorker, media) routes through, so the denial is enforced ONCE at the source.
test('#49 Q4 cageReadsRepoEnv: adversary DENIES, no-cage ALLOWS, unknown FAIL-CLOSED', () => {
  assert.equal(CAGE_PROFILES.adversary.repoEnv, 'none')
  assert.equal(cageReadsRepoEnv('adversary'), false, 'the adversary cage denies repo .env')
  assert.equal(cageReadsRepoEnv(undefined), true, 'no cage → reads normally (uncaged members unchanged)')
  assert.equal(cageReadsRepoEnv('bogus-unknown'), false, 'unknown/unready cage name → DENY (fail-closed, via the mint gate)')
})
test('#49 Q4 memberRepoEnvKey chokepoint: an UNCAGED member reads its repo .env; a CAGED (adversary) member is DENIED even with the secret right there', () => {
  const repo = mkdtempSync(join(tmpdir(), 'mrc-cageenv-'))
  try {
    writeFileSync(join(repo, '.env'), 'GEMINI_API_KEY=super-secret-123\n')
    assert.equal(memberRepoEnvKey({ repo, cage: undefined }, 'GEMINI_API_KEY'), 'super-secret-123', 'uncaged member reads the real secret')
    assert.equal(memberRepoEnvKey({ repo, cage: 'adversary' }, 'GEMINI_API_KEY'), '', 'CAGED member is denied at the chokepoint — no foreign/own repo secret into a cage')
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// ─── #49 cross-repo × cage — item #4: a caged member's /rooms is its OWN room(s), never roomsRoot, fail-closed ───
test('#49 item4 cagedRoomVolumes: mounts EACH own room (plural) individually as /rooms/<rid>:ro, never roomsRoot', () => {
  const root = '/home/me/.local/share/mrc/rooms'
  const v = cagedRoomVolumes(['r-aaa', 'r-bbb'], root, () => true)
  assert.deepEqual(v, ['-v', `${root}/r-aaa:/rooms/r-aaa:ro`, '-v', `${root}/r-bbb:/rooms/r-bbb:ro`])
  assert.ok(!v.some((x) => x === `${root}:/rooms:ro`), 'NEVER the whole roomsRoot tree (the cross-session disclosure)')
})
test('#49 item4 cagedRoomVolumes: FAIL-CLOSED on empty/invalid — returns [] (no /rooms mount), never roomsRoot', () => {
  const root = '/home/me/rooms'
  assert.deepEqual(cagedRoomVolumes([], root), [], 'empty membership → no /rooms mount')
  assert.deepEqual(cagedRoomVolumes(undefined, root), [], 'undefined → []')
  assert.deepEqual(cagedRoomVolumes(['r-x'], root, () => false), [], 'room dir absent → skipped (fail-closed), not roomsRoot')
})
test('#49 item4 cagedRoomVolumes: a `..` in a room id is REJECTED (subdir-of-root guard)', () => {
  const root = '/home/me/rooms'
  assert.deepEqual(cagedRoomVolumes(['../../etc', 'r-ok'], root, () => true), ['-v', `${root}/r-ok:/rooms/r-ok:ro`], 'the escaping id is dropped, the real one survives')
})

// ─── #49 cross-repo × cage — item #3: a caged launch must never resolve to the USER's login vol ───
test('#49 item3 resolvedVolIsUserLogin: the user login FAMILY trips it; a member vol + the pierre pool do NOT', () => {
  const repo = '/home/me/proj'
  assert.equal(resolvedVolIsUserLogin(volumeName(repo), repo, volumeName), true, 'slot-1 login vol → REFUSE')
  assert.equal(resolvedVolIsUserLogin(volumeName(repo, 2), repo, volumeName), true, 'slot-N login vol → REFUSE')
  // a legitimately-caged CROSS-REPO member vol (a DIFFERENT hash) must NOT trip it (else the cage can never launch)
  const memberVol = memberConfigVolName({ repo: '/srv/shared', handle: 'apolline/claude', crossRepo: true }, '/srv/shared', 'orgA')
  assert.equal(resolvedVolIsUserLogin(memberVol, repo, volumeName), false, 'org-scoped member vol is not the user login')
  // the pierre-slot pool vol (…-pierre-N, not -<digits>) must NOT trip it either
  assert.equal(resolvedVolIsUserLogin(`${volumeName(repo, 1)}-pierre-3`, repo, volumeName), false, 'the pierre pool vol is a legit caged vol, not the login')
})

// ─── #49 cross-repo × cage — item #5: FAIL-CLOSED deferral (a caged member is REFUSED at launch in Phase-1) ───
// roster.js parse-ACCEPTS member.cage (validated); the launch does not yet ENFORCE it (Phase-2). So the launch
// MUST refuse a caged member, never run it uncaged with a false adversary:false record (the silent-uncage bug).
test('#49 item5 memberCageLaunchGate: a caged member is REFUSED (fail-closed) until Phase-2 wires enforcement; uncaged passes', () => {
  const caged = memberCageLaunchGate({ handle: 'x/claude', cage: 'adversary' })
  assert.equal(caged.ok, false, 'a declared cage that the launch cannot yet enforce → REFUSE (never launch uncaged)')
  assert.match(caged.reason, /does not YET enforce|silent uncage|adversary:false/i)
  assert.equal(memberCageLaunchGate({ handle: 'y/claude' }).ok, true, 'an uncaged member launches normally')
  assert.equal(memberCageLaunchGate({ handle: 'z/claude', cage: false }).ok, true, 'cage:false is uncaged')
})
// Pierre note verified: cageReadsRepoEnv('contained') is FALSE today (fail-closed — contained is un-mintable via
// resolveCageProfile's readiness gate), NOT true. It flips to reading its OWN repo .env only when the contained
// tier ships (classifier:true) — a conscious grant then, not an accident now.
test('#49 cageReadsRepoEnv(contained) is fail-closed FALSE until the tier ships', () => {
  assert.equal(cageReadsRepoEnv('contained'), false)
})
// trap #3: adversaryIdentity must extend to a caged member, or it gets the user's /mrc slice + a false record.
test('#49 trap3 cageIsAdversary: adversary→true; no-cage/contained/unknown → fail-closed FALSE', () => {
  assert.equal(cageIsAdversary('adversary'), true, 'the adversary profile confers adversary identity')
  assert.equal(cageIsAdversary(undefined), false, 'no cage → not an adversary')
  assert.equal(cageIsAdversary('contained'), false, 'un-mintable tier → fail-closed false (not adversary identity)')
  assert.equal(cageIsAdversary('bogus'), false, 'unknown → fail-closed false')
})
// item #5 TWIN: the worker-exec path is symmetric — a caged worker REFUSES (short-circuits before any docker),
// so a future worker-compatible cage tier can't ship silently uncaged with ALLOW_WEB=1 on the worker side.
test('#49 item5-twin execWorker: a caged worker member is REFUSED (ok:false), never launched uncaged', async () => {
  const r = await execWorker(null, { handle: 'w/codex', cage: 'adversary', backend: 'codex' }, '/tmp/x', 'do a thing')
  assert.equal(r.ok, false, 'caged worker → graceful refuse, before loadEnv/docker')
  assert.match(r.text, /refused/i)
})
