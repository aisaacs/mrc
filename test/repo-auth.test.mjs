// #49 multi-repo Inc 1 — the per-org authorized-repo set + the resolveMemberRepo mint gate. The record is a
// HOST-ONLY file, so tests use a unique per-run org and clean it up. Real temp repos (realpath resolves them).
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveMemberRepo, addAuthorizedRepo, removeAuthorizedRepo, loadAuthorizedRepos, resolveOrgRoot, resolveOrgRootForOrg, pinnedOrgRoot, clearOrgRoot, recordActivatedRoot, isActivatedRoot, clearActivatedRoots, expandHome, orgAnchorDir, _rootPathForTest, _activatedPathForTest, _authPathForTest, _orgAnchorRootForTest } from '../src/teams/repo-auth.js'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, sep } from 'node:path'

// P1 (create→launch): a human types `~/code/app` in the CLI or the create form; expandHome resolves the leading
// `~`/`~/`/`$HOME` BEFORE realpath (which treats `~` as a literal → ENOENT). It's a spelling fix on the feed only —
// never `~user`, never an absolute/relative path — so the trusted realpath + broad-guards downstream are unchanged.
test('expandHome expands a LEADING ~ / ~/ / $HOME to the home dir, and ONLY that', () => {
  const H = homedir()
  assert.equal(expandHome('~'), H)
  assert.equal(expandHome('~/code/app'), join(H, 'code/app'))
  assert.equal(expandHome('$HOME'), H)
  assert.equal(expandHome('$HOME/x'), join(H, 'x'))
  assert.equal(expandHome('/abs/path'), '/abs/path')   // absolute untouched
  assert.equal(expandHome('~user/x'), '~user/x')       // NOT `~/` → never guess another user's home
  assert.equal(expandHome('rel/path'), 'rel/path')     // relative untouched
})

let orgN = 0
function scratch() {
  const org = `test-repoauth-${process.pid}-${orgN++}`
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-ra-')))
  const orgRepo = join(root, 'orgrepo'); mkdirSync(orgRepo)
  const other = join(root, 'otherrepo'); mkdirSync(other)
  return { org, root, orgRepo, other,
    cleanup: () => { rmSync(root, { recursive: true, force: true }); try { unlinkSync(_authPathForTest(org)) } catch {} },
    cleanupActivation: () => { rmSync(root, { recursive: true, force: true }); try { unlinkSync(_activatedPathForTest(org)) } catch {} } }
}

test('resolveMemberRepo: default (no request) → the org repo, realpath-canonical', () => {
  const s = scratch()
  try { assert.equal(resolveMemberRepo(s.orgRepo, undefined, s.org), s.orgRepo) } finally { s.cleanup() }
})

test('resolveMemberRepo: own-repo grant — requesting the org repo (any spelling) is always allowed', () => {
  const s = scratch()
  try {
    assert.equal(resolveMemberRepo(s.orgRepo, s.orgRepo, s.org), s.orgRepo)
    const link = join(s.root, 'orglink'); symlinkSync(s.orgRepo, link)   // a symlink spelling still resolves to the own repo
    assert.equal(resolveMemberRepo(s.orgRepo, link, s.org), s.orgRepo)
  } finally { s.cleanup() }
})

test('resolveMemberRepo: an UNAUTHORIZED cross-repo is REFUSED (fail-closed — empty set by default)', () => {
  const s = scratch()
  try { assert.throws(() => resolveMemberRepo(s.orgRepo, s.other, s.org), /not authorized/) } finally { s.cleanup() }
})

test('resolveMemberRepo: after a HUMAN addAuthorizedRepo, the cross-repo resolves (realpath-canonical match)', () => {
  const s = scratch()
  try {
    addAuthorizedRepo(s.org, s.other)
    assert.equal(resolveMemberRepo(s.orgRepo, s.other, s.org), s.other)
    const link = join(s.root, 'otherlink'); symlinkSync(s.other, link)   // a symlink spelling of the authorized repo still matches
    assert.equal(resolveMemberRepo(s.orgRepo, link, s.org), s.other)
  } finally { s.cleanup() }
})

// Model B (Inc 3): the authorized-set is the SOLE gate — the own-repo grant is DELETED. Every mountable member repo
// must be EXPLICIT and in the human-authorized set, or THROW. There is no `return orgReal` path: proves the cross-site
// floor claim's Site-1 half — every return reaches loadAuthorizedRepos(org).has(...) or a throw. (modelB is passed only
// on the team-parse path; solo never sets it, so a store-capable image's solo launch keeps its own-repo default.)
test('resolveMemberRepo Model B (Inc 3): SOLE-gate — own-repo grant deleted; every repo must be in the set (or throw)', () => {
  const s = scratch()
  try {
    // The org repo itself is NOT auto-granted under Model B — no special-casing; unauthorized → throw.
    assert.throws(() => resolveMemberRepo(s.orgRepo, s.orgRepo, s.org, { modelB: true }), /not authorized/, 'own-repo grant is GONE — the org repo is just another repo')
    // A missing member.repo is an ERROR (no org-root default to fall back to under Model B).
    assert.throws(() => resolveMemberRepo(s.orgRepo, undefined, s.org, { modelB: true }), /explicit repo is required/)
    assert.throws(() => resolveMemberRepo(s.orgRepo, '', s.org, { modelB: true }), /explicit repo is required/)
    // An unauthorized cross-repo → refused (fail-closed).
    assert.throws(() => resolveMemberRepo(s.orgRepo, s.other, s.org, { modelB: true }), /not authorized/)
    // After a HUMAN addAuthorizedRepo, it resolves — the set is the ONLY way in.
    addAuthorizedRepo(s.org, s.other)
    assert.equal(resolveMemberRepo(s.orgRepo, s.other, s.org, { modelB: true }), s.other)
    // Even the org repo, once authorized, resolves — proving it's not special, just another set entry.
    addAuthorizedRepo(s.org, s.orgRepo)
    assert.equal(resolveMemberRepo(s.orgRepo, s.orgRepo, s.org, { modelB: true }), s.orgRepo)
  } finally { s.cleanup() }
})

test('broad-guard is on the IMPLICIT own-repo grant only (Pierre #3): a "/"/$HOME ORG repo is refused', () => {
  const s = scratch()
  try {
    // The auto-authorization (own-repo grant) is broad-guarded — an org repo that resolves to / or $HOME refuses.
    assert.throws(() => resolveMemberRepo(sep, sep, s.org), /filesystem root/)
    assert.throws(() => resolveMemberRepo(homedir(), 'x', s.org), /home directory/)
    // But a REQUEST resolving to $HOME is refused by the SET-check (not a separate denylist) — it isn't in the set.
    assert.throws(() => resolveMemberRepo(s.orgRepo, homedir(), s.org), /not authorized/)
    // and the human can't even ADD / or $HOME (the add broad-guards).
    assert.throws(() => addAuthorizedRepo(s.org, homedir()), /home directory/)
  } finally { s.cleanup() }
})

test('authorized-repo record is HOST-ONLY (under homedir/.local/share/mrc), never repo-relative', () => {
  const s = scratch()
  try {
    const p = _authPathForTest(s.org)
    assert.ok(p.startsWith(join(homedir(), '.local', 'share', 'mrc')), 'record lives host-side')
    assert.ok(!p.includes(s.orgRepo), 'record is not inside any repo — a container can neither read nor mutate it')
  } finally { s.cleanup() }
})

test('cross-org isolation of the KEY: orgs whose names slug-COLLIDE get DISTINCT records (Pierre)', () => {
  // `acme.prod` and `acme_prod` collapse to the same slug — a lossy key would SHARE their authorized-set (a
  // cross-org privilege leak, attacker-triggerable via a slug-colliding org name). The injective (hex) key
  // keeps them distinct: authorizing a repo for one does NOT authorize it for the other.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-ra-')))
  const repoX = join(root, 'repox'); mkdirSync(repoX)
  const orgA = `acme.prod-${process.pid}`, orgB = `acme_prod-${process.pid}`
  try {
    assert.notEqual(_authPathForTest(orgA), _authPathForTest(orgB), 'slug-colliding orgs get distinct record files')
    addAuthorizedRepo(orgA, repoX)
    assert.ok(loadAuthorizedRepos(orgA).has(repoX), 'orgA has its repo')
    assert.equal(loadAuthorizedRepos(orgB).size, 0, 'orgB does NOT inherit orgA\'s grant (no shared set)')
    assert.throws(() => resolveMemberRepo(root, repoX, orgB), /not authorized/, 'orgB still refuses the repo orgA authorized')
  } finally { rmSync(root, { recursive: true, force: true }); try { unlinkSync(_authPathForTest(orgA)) } catch {}; try { unlinkSync(_authPathForTest(orgB)) } catch {} }
})

// ── GUARD #1 (dashboard-ux floor): the org ROOT is pinned WRITE-ONCE, and a first-pin is a privileged act ──
// The org root is identity-defining (project = intent = root) and STRICTLY BROADER than a member-host repo (it's
// the default rw mount + the `.env`-read root for every default-repo member), so it is NOT the member
// authorized-set (that would over-grant a member-eligible repo into a root). Write-once: set at create, immutable.
test('resolveOrgRoot: FIRST-pin — a TRUSTED origin (CLI argv / human-picker create) establishes the root', () => {
  const s = scratch()
  try {
    // trusted first-pin returns the realpath-canonical root (a symlink spelling resolves through)
    assert.equal(resolveOrgRoot(null, s.orgRepo, { trusted: true }), s.orgRepo)
    const link = join(s.root, 'orglink'); symlinkSync(s.orgRepo, link)
    assert.equal(resolveOrgRoot('', link, { trusted: true }), s.orgRepo)
    // trusted keeps the `mrc ~` exemption — a human may root their own $HOME if they typed it
    assert.equal(resolveOrgRoot(null, homedir(), { trusted: true }), realpathSync(homedir()))
  } finally { s.cleanup() }
})

test('resolveOrgRoot: FIRST-pin — an UNTRUSTED wire origin can NEVER establish a root (define-time .env-read defense)', () => {
  const s = scratch()
  try {
    // A raw defineOrg over the control socket must not be able to first-pin — else it reads/mounts a
    // wire-chosen path before a human authorized it. This is the guard the value-check alone sails past.
    assert.throws(() => resolveOrgRoot(null, s.orgRepo, { trusted: false }), /untrusted define cannot establish/)
    assert.throws(() => resolveOrgRoot('', '/victim', { trusted: false }), /untrusted define cannot establish/)
    assert.throws(() => resolveOrgRoot(null, '/victim'), /untrusted define cannot establish/)   // default is untrusted
  } finally { s.cleanup() }
})

test('resolveOrgRoot: a trusted first-pin still refuses the filesystem root ("/")', () => {
  assert.throws(() => resolveOrgRoot(null, sep, { trusted: true }), /filesystem root/)
})

test('resolveOrgRoot: WRITE-ONCE — an EXISTING pin accepts only a matching request, whoever asks', () => {
  const s = scratch()
  try {
    // a request resolving to the pinned root is accepted even from an untrusted origin (it changes nothing)
    assert.equal(resolveOrgRoot(s.orgRepo, s.orgRepo, { trusted: false }), s.orgRepo)
    const link = join(s.root, 'orglink2'); symlinkSync(s.orgRepo, link)
    assert.equal(resolveOrgRoot(s.orgRepo, link, { trusted: false }), s.orgRepo)   // symlink spelling still matches
  } finally { s.cleanup() }
})

test('resolveOrgRoot: WRITE-ONCE beats trust — a DIFFERING root is refused even from a trusted origin', () => {
  const s = scratch()
  try {
    // the re-root bypass: a later (even "trusted") define pointing elsewhere must NOT re-root the project
    assert.throws(() => resolveOrgRoot(s.orgRepo, s.other, { trusted: true }), /refusing to re-root/)
    assert.throws(() => resolveOrgRoot(s.orgRepo, '/victim', { trusted: false }), /refusing to re-root/)
  } finally { s.cleanup() }
})

// ── GUARD #1 — the ACTIVATION record: a per-org set of CONFIRMED REALPATHS (authorized-repos applied to the
// root). Activation (the define-time `.env` read + TG bridge + writeTeamFile) fires iff realpath(def.repo) is in
// the org's recorded set — a VALUE match, not a name-keyed boolean, so a delete→recreate to a different root can
// never inherit activation (the removeorg-doesn't-purge vector). Host-only, hex-keyed (injective).
// ── GUARD #1 — the write-once PIN RECORD + chokepoint. resolveOrgRoot is only as strong as every caller passing
// the stored pin; the chokepoint LOADS it internally so no ingress (defineOrg/launchteam/relaunchmember/activate/
// boot) can pass a null pin for a pinned org and silently re-root. The record write is O_EXCL (write-once under
// concurrency); the EEXIST loser re-loads + validates through the existing-pin branch.
test('pin chokepoint: FIRST trusted call pins + persists; a later DIFFERENT root is refused even trusted (un-forgettable write-once)', () => {
  const s = scratch()
  try {
    assert.equal(pinnedOrgRoot(s.org), null)                                        // no pin yet
    assert.equal(resolveOrgRootForOrg(s.org, s.orgRepo, { trusted: true }), s.orgRepo)   // first-pin persists
    assert.equal(pinnedOrgRoot(s.org), s.orgRepo)
    // a later call passing a DIFFERENT repo — the chokepoint loads the stored pin, so it CANNOT re-root, trusted or not
    assert.throws(() => resolveOrgRootForOrg(s.org, s.other, { trusted: true }), /refusing to re-root/)
    assert.throws(() => resolveOrgRootForOrg(s.org, s.other, { trusted: false }), /refusing to re-root/)
    // the SAME root (any spelling) is idempotent
    assert.equal(resolveOrgRootForOrg(s.org, s.orgRepo, { trusted: false }), s.orgRepo)
  } finally { s.cleanup(); try { unlinkSync(_rootPathForTest(s.org)) } catch {} }
})

test('pin chokepoint: an UNTRUSTED first call cannot establish a pin and persists NOTHING', () => {
  const s = scratch()
  try {
    assert.throws(() => resolveOrgRootForOrg(s.org, s.orgRepo, { trusted: false }), /untrusted define cannot establish/)
    assert.equal(pinnedOrgRoot(s.org), null, 'nothing persisted — an attacker root never enters durable state')
  } finally { s.cleanup(); try { unlinkSync(_rootPathForTest(s.org)) } catch {} }
})

test('pin chokepoint: clearOrgRoot lets a deliberate delete→recreate re-pin (a human act, not a wire re-root)', () => {
  const s = scratch()
  try {
    resolveOrgRootForOrg(s.org, s.orgRepo, { trusted: true })
    clearOrgRoot(s.org)                                              // removeorg (human delete)
    assert.equal(pinnedOrgRoot(s.org), null)
    assert.equal(resolveOrgRootForOrg(s.org, s.other, { trusted: true }), s.other)   // recreate → a NEW root is fine
  } finally { s.cleanup(); try { unlinkSync(_rootPathForTest(s.org)) } catch {} }
})

test('pin record is HOST-ONLY + hex-keyed injective (slug-colliding orgs get distinct pins)', () => {
  const s = scratch()
  try {
    const p = _rootPathForTest(s.org)
    assert.ok(p.startsWith(join(homedir(), '.local', 'share', 'mrc')) && !p.includes(s.orgRepo), 'host-only, never in a repo')
    const orgA = `acme.prod-${process.pid}`, orgB = `acme_prod-${process.pid}`
    assert.notEqual(_rootPathForTest(orgA), _rootPathForTest(orgB))
  } finally { s.cleanup(); try { unlinkSync(_rootPathForTest(s.org)) } catch {} }
})

test('activation record: missing → NOT activated (fail-closed: a never-confirmed root stays inert)', () => {
  const s = scratch()
  try { assert.equal(isActivatedRoot(s.org, s.orgRepo), false) } finally { s.cleanupActivation() }
})

test('activation record: record → isActivatedRoot true (realpath-canonical; a symlink spelling still matches)', () => {
  const s = scratch()
  try {
    recordActivatedRoot(s.org, s.orgRepo)
    assert.equal(isActivatedRoot(s.org, s.orgRepo), true)
    const link = join(s.root, 'actlink'); symlinkSync(s.orgRepo, link)
    assert.equal(isActivatedRoot(s.org, link), true)   // a different spelling of the confirmed root matches
  } finally { s.cleanupActivation() }
})

test('activation record: VALUE-BOUND — a DIFFERENT root is NOT activated (kills delete→recreate inheritance)', () => {
  const s = scratch()
  try {
    recordActivatedRoot(s.org, s.orgRepo)
    // the delete→recreate vector: org name X survives with an activation record, but a recreate to /other
    // must NOT read as activated, because the recorded VALUE (realpath) doesn't match the new root.
    assert.equal(isActivatedRoot(s.org, s.other), false)
  } finally { s.cleanupActivation() }
})

test('activation record: clearActivatedRoots purges (the removeorg hygiene path)', () => {
  const s = scratch()
  try {
    recordActivatedRoot(s.org, s.orgRepo)
    assert.equal(isActivatedRoot(s.org, s.orgRepo), true)
    clearActivatedRoots(s.org)
    assert.equal(isActivatedRoot(s.org, s.orgRepo), false)
  } finally { s.cleanupActivation() }
})

test('$HOME align-RESTRICTIVE (Pierre): pin PERMITS $HOME (mount), activate SKIPS it — mrc team up ~ never reads ~/.env', () => {
  // The coherent rule: pin permits the broad root (the MOUNT choice), activate refuses to auto-read a broad root's
  // secrets. The `mrc team up ~` break is fixed by SKIP-not-throw, WITHOUT widening the .env read to $HOME. This is
  // the invariant — "pins, mounts, does NOT activate, does NOT read ~/.env" — not "both permit".
  const home = realpathSync(homedir())
  const org = `test-homerestrict-${process.pid}`
  try {
    assert.equal(resolveOrgRoot(null, homedir(), { trusted: true }), home)   // pin $HOME → allowed (mount)
    assert.equal(recordActivatedRoot(org, homedir()), null)                  // activate $HOME → SKIPPED (null), no throw
    assert.equal(isActivatedRoot(org, homedir()), false)                     // → NOT activated → its .env is never read
    // `/` is skipped too (never thrown from the activate path), and a real project DOES activate
    assert.equal(recordActivatedRoot(org, sep), null)
    const proj = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-hr-')))
    try { assert.equal(recordActivatedRoot(org, proj), proj); assert.equal(isActivatedRoot(org, proj), true) }
    finally { rmSync(proj, { recursive: true, force: true }) }
  } finally { try { unlinkSync(_activatedPathForTest(org)) } catch {} }
})

test('activation record: hex-keyed injective — slug-colliding orgs do NOT share activation', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mrc-act-')))
  const repoX = join(root, 'repox'); mkdirSync(repoX)
  const orgA = `acme.prod-${process.pid}`, orgB = `acme_prod-${process.pid}`
  try {
    assert.notEqual(_activatedPathForTest(orgA), _activatedPathForTest(orgB), 'slug-colliding orgs get distinct activation records')
    recordActivatedRoot(orgA, repoX)
    assert.equal(isActivatedRoot(orgA, repoX), true, 'orgA activated its root')
    assert.equal(isActivatedRoot(orgB, repoX), false, 'orgB does NOT inherit orgA\'s activation')
  } finally { rmSync(root, { recursive: true, force: true }); try { unlinkSync(_activatedPathForTest(orgA)) } catch {}; try { unlinkSync(_activatedPathForTest(orgB)) } catch {} }
})

test('loadAuthorizedRepos: missing record → empty set (fail-closed); add/remove round-trip is idempotent', () => {
  const s = scratch()
  try {
    assert.equal(loadAuthorizedRepos(s.org).size, 0)
    addAuthorizedRepo(s.org, s.other)
    assert.equal(loadAuthorizedRepos(s.org).size, 1)
    assert.equal(removeAuthorizedRepo(s.org, s.other), true)
    assert.equal(loadAuthorizedRepos(s.org).size, 0)
    assert.equal(removeAuthorizedRepo(s.org, s.other), false)   // idempotent
  } finally { s.cleanup() }
})

// Model B (Inc 3, Site 4): the org's NEUTRAL IDENTITY ANCHOR — a derived, host-only, hex-keyed path. It is the
// project's identity in Model B (tied to no repo) and holds the TG `.env` secret, so it MUST be a distinct tree
// that is never a container mount (crack-C). Derived + hex-injective → immutable-by-derivation (no pin needed).
test('orgAnchorDir: derived, hex-keyed, host-only, injective; distinct from #5\'s mounted store tree', () => {
  const a = orgAnchorDir('acme')
  assert.equal(a, orgAnchorDir('acme'), 'derived + stable — same org → same anchor (immutable by derivation)')
  assert.notEqual(orgAnchorDir('acme.prod'), orgAnchorDir('acme_prod'), 'hex-injective — a lossy slug would collide these')
  assert.ok(a.startsWith(_orgAnchorRootForTest()), 'under the dedicated org-anchors/ tree')
  assert.ok(a.includes('/.local/share/mrc/org-anchors/'), 'host-only mrc state dir, NOT a repo, NOT the store slice tree')
  assert.match(a.slice(_orgAnchorRootForTest().length + 1), /^[0-9a-f]+$/, 'the key is a hex encoding of the org name')
  assert.equal(orgAnchorDir('acme'), _orgAnchorRootForTest() + '/' + Buffer.from('acme', 'utf8').toString('hex'))
})
